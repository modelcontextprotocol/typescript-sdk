/*
 * The local replay-aware `Step` implementation (the engine contract)): the wrapper the
 * executor builds around the per-lease `DurableStep` stub for exactly one
 * `runTask` invocation. `step.do` memoizes through the journal, `step.sleep` /
 * `step.sleepUntil` / `step.elicit` record durable wakes and suspend the
 * invocation, and per-step retry policy is computed here and recorded DO-side.
 *
 * The timeout/abort race, the retry/terminal failure catch, and the
 * memoization shape are adapted from avenceslau/durability, pinned at commit
 * 78cb099 (v2.1.0): `packages/durability/src/index.ts` (`execute()` skeleton —
 * claim, timeout race, guarded success, retry/terminal catch). The in-DO
 * journal writes are replaced by calls on the `DurableStep` RPC stub.
 * https://github.com/avenceslau/durability
 */

import { exponential, jitter } from '../engine/backoff';
import { DEFAULT_STEP_TIMEOUT_MS } from '../engine/defaults';
import type { DurationString } from '../engine/duration';
import { parseDuration } from '../engine/duration';
import type { SerializedError } from '../engine/errors';
import {
    AttemptsExhaustedError,
    DuplicateStepError,
    isNonRetryable,
    RetryPolicyError,
    serializeError,
    StepTimeoutError
} from '../engine/errors';
import type { StepJournal } from '../engine/protocol';
import { serializeValue } from '../engine/serialization';
import type { InputRequest, InputResponse } from '../wire/types';
import type { ElicitConfig, ElicitOutcome, JsonSerializable, RetryPolicy, Step, StepConfig } from './types';

/**
 * @internal Thrown by the step wrapper to end the current invocation without
 * failing the task: a sleep/elicit was recorded, a step retry was scheduled,
 * or cancellation was observed — the Durable Object already journaled why and
 * the alarm resumes later. The executor maps it to `{outcome: "suspended"}`;
 * it never crosses an RPC boundary.
 */
export class SuspendSignal extends Error {
    constructor(reason: string) {
        super(`Task invocation suspended: ${reason}`);
        this.name = 'SuspendSignal';
    }
}

/**
 * Merges the task-level retry policy with a per-step override (the engine contract))
 * and validates it — an invalid policy is a terminal engine failure.
 *
 * @throws RetryPolicyError when the merged policy is unusable.
 */
export const resolveRetryPolicy = (
    taskPolicy: Required<RetryPolicy>,
    override: RetryPolicy | undefined,
    entity: string
): Required<RetryPolicy> => {
    const merged = {
        limit: override?.limit ?? taskPolicy.limit,
        baseDelayMs: override?.baseDelayMs ?? taskPolicy.baseDelayMs,
        maxDelayMs: override?.maxDelayMs ?? taskPolicy.maxDelayMs
    };
    if (
        !Number.isSafeInteger(merged.limit) ||
        merged.limit < 1 ||
        !Number.isFinite(merged.baseDelayMs) ||
        merged.baseDelayMs < 0 ||
        !Number.isFinite(merged.maxDelayMs) ||
        merged.maxDelayMs < 0
    ) {
        throw new RetryPolicyError(entity);
    }
    return merged;
};

/**
 * Computes the backoff delay before retrying a failed step attempt:
 * exponential from the policy base to its cap, with equal jitter.
 *
 * @throws RetryPolicyError when the policy produces an unsafe delay.
 */
export const computeStepRetryDelayMs = (policy: Required<RetryPolicy>, attempt: number, entity: string): number => {
    const delay = Math.round(jitter(exponential(attempt, policy.baseDelayMs, policy.maxDelayMs)));
    if (!Number.isSafeInteger(delay) || delay < 0) {
        throw new RetryPolicyError(entity);
    }
    return delay;
};

/** Rebuilds a throwable from a persisted `{name, message}` pair. */
const rehydrateError = (detail: SerializedError): Error => {
    const error = new Error(detail.message);
    error.name = detail.name;
    return error;
};

/**
 * Races a step closure against its per-attempt timeout. The closure promise
 * gets a no-op rejection handler so a late failure after a lost race is never
 * reported as unhandled.
 */
const runClosureWithTimeout = async <T>(name: string, fn: () => T | Promise<T>, timeoutMs: number): Promise<T> => {
    const closure = (async () => fn())();
    void closure.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            closure,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new StepTimeoutError(name, timeoutMs)), timeoutMs);
            })
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
};

/**
 * The replay-aware {@link Step} handed to task handlers. Constructed by the
 * executor per invocation around the per-lease {@link StepJournal}; every
 * journal effect goes through the stub (and is therefore generation-guarded
 * DO-side). Step-name uniqueness within one run is enforced locally so a
 * same-run duplicate fails loudly instead of silently replaying a journal hit
 * (decision D8).
 */
export class ReplayStep implements Step {
    readonly #stub: StepJournal;
    readonly #taskId: string;
    readonly #taskRetries: Required<RetryPolicy>;
    readonly #usedNames = new Set<string>();
    /**
     * False while the handler is replaying ground an earlier run already
     * published; true once it is on new ground. The first claim is live from
     * the start. A later claim goes live at the point the previous run stopped:
     * the sleep or elicit it suspended on (a hit on replay), or the first
     * journal miss (a closure that runs, a pending sleep, a fresh elicit).
     * `step.status` writes only when live, so a resume never re-publishes the
     * beats that came before the suspension point.
     */
    #live: boolean;

    constructor(stub: StepJournal, taskId: string, taskRetries: Required<RetryPolicy>, attempt = 1) {
        this.#stub = stub;
        this.#taskId = taskId;
        this.#taskRetries = taskRetries;
        // The first claim has no journal to replay: everything it does is live.
        // Later claims (resume after a suspend, redelivery after a crash) replay
        // journaled ground first and go live at their first miss.
        this.#live = attempt <= 1;
    }

    readonly idempotencyKey = (stepName: string): string => `${this.#taskId}:${stepName}`;

    do<T extends JsonSerializable>(name: string, fn: () => T | Promise<T>): Promise<T>;
    do<T extends JsonSerializable>(name: string, config: StepConfig, fn: () => T | Promise<T>): Promise<T>;
    do<T extends JsonSerializable>(
        name: string,
        configOrFn: StepConfig | (() => T | Promise<T>),
        maybeFn?: () => T | Promise<T>
    ): Promise<T> {
        const config = typeof configOrFn === 'function' ? undefined : configOrFn;
        const fn = typeof configOrFn === 'function' ? configOrFn : maybeFn;
        if (typeof fn !== 'function') {
            throw new TypeError(`step.do("${name}") requires a closure`);
        }
        return this.#runDo(name, config, fn);
    }

    async sleep(name: string, duration: number | DurationString): Promise<void> {
        this.#claimName(name, 'step.sleep');
        await this.#recordSleep(name, Date.now() + parseDuration(duration));
    }

    async sleepUntil(name: string, when: number | Date): Promise<void> {
        this.#claimName(name, 'step.sleepUntil');
        const wakeAtMs = when instanceof Date ? when.getTime() : when;
        if (!Number.isFinite(wakeAtMs)) {
            throw new RangeError(`step.sleepUntil("${name}") requires a valid time, got ${String(when)}`);
        }
        await this.#recordSleep(name, Math.round(wakeAtMs));
    }

    elicit(name: string, request: InputRequest): Promise<InputResponse>;
    elicit(name: string, request: InputRequest, config: ElicitConfig): Promise<ElicitOutcome>;
    async elicit(name: string, request: InputRequest, config?: ElicitConfig): Promise<InputResponse | ElicitOutcome> {
        this.#claimName(name, 'step.elicit');
        let timeoutAtMs: number | undefined;
        const timeoutMs = config?.timeoutMs;
        if (timeoutMs !== undefined) {
            if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
                throw new RangeError(`step.elicit("${name}") timeoutMs must be a positive integer, got ${timeoutMs}`);
            }
            // The deadline is journaled with the request on FIRST record and is
            // immutable across replays: this recomputation is ignored on a hit.
            timeoutAtMs = Date.now() + timeoutMs;
        }
        const state = await this.#stub.recordElicit(name, request, timeoutAtMs);
        // A pending elicit is a fresh suspension (new ground). An answered or
        // timed-out one is a hit: only the LATEST suspension point marks the
        // boundary back onto new ground (see SleepState.latest).
        if (state.state === 'pending' || state.latest) this.#live = true;
        if (state.state === 'timed_out') {
            // Only reachable through a config: a deadline exists only when one was
            // recorded, and replays re-run the same call shape (determinism rule).
            return { outcome: 'timed_out' };
        }
        if (state.state === 'answered') {
            const response = state.response as InputResponse;
            return config === undefined ? response : { outcome: 'answered', response };
        }
        throw new SuspendSignal(`waiting for input "${name}"`);
    }

    async offer(key: string, request: InputRequest): Promise<void> {
        // The key shares the lifetime-unique namespace with step names (decision
        // D8): a same-run reuse fails loudly here; a replay's re-offer is the
        // DO-side no-op (the existing row stands).
        this.#claimName(key, 'step.offer');
        await this.#stub.recordOffer(key, request);
    }

    async checkInput(name: string, key: string): Promise<InputResponse | null> {
        this.#claimName(name, 'step.checkInput');
        if (typeof key !== 'string' || key.length === 0) {
            throw new TypeError(`step.checkInput("${name}") requires a non-empty offer key`);
        }
        // Journaled DO-side under `name`: a hit consumes the answer, a miss is
        // recorded as such, and replays observe the journaled value either way.
        const state = await this.#stub.checkInput(name, key);
        return state.state === 'answered' ? (state.response as InputResponse) : null;
    }

    async status(message: string): Promise<void> {
        if (typeof message !== 'string') {
            throw new TypeError(`step.status requires a string message, got ${typeof message}`);
        }
        // Not a journaled step: no name claim, no journal row. It writes ONLY
        // once the handler is live (past its last journal hit): a replay re-runs
        // the handler from the top, and without this gate it would re-publish
        // every earlier beat with a fresh lastUpdatedAt — pollers saw old prose
        // come back as new after a fork. Shape + size of `meta` are enforced
        // DO-side (the single authority).
        if (!this.#live) return;
        await this.#stub.setStatus(message);
    }

    // ------------------------------------------------------------ internals --

    #claimName(name: string, api: string): void {
        if (name.length === 0) {
            throw new TypeError(`${api} requires a non-empty step name`);
        }
        if (this.#usedNames.has(name)) {
            throw new DuplicateStepError(name);
        }
        this.#usedNames.add(name);
    }

    async #recordSleep(name: string, wakeAtMs: number): Promise<void> {
        const state = await this.#stub.recordSleep(name, wakeAtMs);
        if (state.state === 'pending') {
            this.#live = true;
            throw new SuspendSignal(`sleeping "${name}" until ${new Date(wakeAtMs).toISOString()}`);
        }
        // Journal hit: the wake already elapsed. Only the LATEST suspension point
        // (the last sleep/elicit the previous run recorded) marks the boundary
        // back onto new ground; earlier completed sleeps are old ground replayed.
        if (state.latest) this.#live = true;
    }

    async #runDo<T extends JsonSerializable>(name: string, config: StepConfig | undefined, fn: () => T | Promise<T>): Promise<T> {
        this.#claimName(name, 'step.do');
        const entity = `step "${name}"`;
        const policy = resolveRetryPolicy(this.#taskRetries, config?.retries, entity);
        const timeoutMs = config?.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
            throw new RangeError(`step.do("${name}") timeoutMs must be a positive integer, got ${timeoutMs}`);
        }

        const directive = await this.#stub.beginStep(name, { timeoutMs });
        switch (directive.state) {
            case 'completed': {
                // Journal hit: the persisted result; the closure MUST NOT run.
                return directive.value as T;
            }
            case 'failed': {
                // The step failed terminally in an earlier run; replays surface it.
                throw rehydrateError(directive.error);
            }
            case 'cancelled': {
                throw new SuspendSignal(`step "${name}" aborted by cancellation request`);
            }
            case 'run': {
                this.#live = true;
                break;
            }
        }

        const attempt = directive.attempt;
        if (attempt > policy.limit) {
            // A crash after a claim consumes an attempt (the engine contract)): claims can
            // exhaust the limit without a recorded closure error.
            const exhausted = new AttemptsExhaustedError(`Step "${name}"`, policy.limit);
            await this.#stub.failStep(name, serializeError(exhausted), { terminal: true });
            throw exhausted;
        }

        let value: T;
        try {
            value = await runClosureWithTimeout(name, fn, timeoutMs);
        } catch (error) {
            return this.#settleFailedAttempt(name, attempt, policy, error);
        }
        // Validate serialization locally so a non-JSON result surfaces as
        // ResultSerializationError in the executor (engine failure, the engine contract))
        // rather than an opaque RPC rejection.
        serializeValue(value, entity);
        await this.#stub.completeStep(name, value);
        return value;
    }

    async #settleFailedAttempt(name: string, attempt: number, policy: Required<RetryPolicy>, error: unknown): Promise<never> {
        if (error instanceof SuspendSignal) {
            throw error; // a nested suspension propagates untouched
        }
        if (isNonRetryable(error) || attempt >= policy.limit) {
            await this.#stub.failStep(name, serializeError(error), { terminal: true });
            throw error;
        }
        const delayMs = computeStepRetryDelayMs(policy, attempt, `step "${name}"`);
        await this.#stub.failStep(name, serializeError(error), { retryAtMs: Date.now() + delayMs });
        throw new SuspendSignal(`step "${name}" attempt ${attempt} failed; retry in ${delayMs}ms`);
    }
}
