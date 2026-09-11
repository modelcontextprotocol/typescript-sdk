/**
 * The replay-aware step API handed to task handlers (the engine contract)).
 */

import type { DurationString } from '../engine/duration';
import type { InputRequest, InputResponse } from '../wire/types';

/**
 * A value the engine can persist in the step journal: plain JSON, plus
 * `undefined` (round-tripped faithfully through the undefined-safe envelope).
 * Nested `undefined` property values are rejected at serialization time.
 */
export type JsonSerializable = string | number | boolean | null | undefined | JsonSerializable[] | { [key: string]: JsonSerializable };

/** A plain JSON value (no `undefined` anywhere): what `step.status` meta carries. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** A plain JSON object: the optional structured `meta` of `step.status`. */
export interface JsonObject {
    [key: string]: JsonValue;
}

/** Retry policy for step closures (defaults per decision D11). */
export interface RetryPolicy {
    /** Total attempts, including the first. Default 5. */
    limit?: number;
    /** Base delay for exponential backoff with jitter. Default 1_000. */
    baseDelayMs?: number;
    /** Backoff cap. Default 300_000 (5 minutes). */
    maxDelayMs?: number;
}

/** Per-step configuration overriding the task defaults. */
export interface StepConfig {
    /** Overrides the task's default retry policy for this step. */
    retries?: RetryPolicy;
    /** Per-attempt closure timeout in milliseconds. Default 300_000 (5 minutes). */
    timeoutMs?: number;
}

/** Configuration for `step.elicit`. */
export interface ElicitConfig {
    /**
     * Answer deadline in milliseconds from when the request is first recorded.
     * If no `tasks/update` answers within it, the engine resolves the request
     * as timed out at the deadline (via the task alarm): the request is marked
     * answered-by-timeout — late responses to its key are ignored — the task
     * returns to `working`, and the resumed replay resolves the elicit with
     * `{ outcome: "timed_out" }`. Omitted = today's behavior: waits forever.
     */
    timeoutMs?: number;
}

/**
 * Discriminated result of a `step.elicit` called with an {@link ElicitConfig}:
 * the client's response when answered in time, or the timeout marker. The
 * marker is engine-internal state, never a synthetic wire `InputResponse` —
 * the wire only ever sees real client responses.
 */
export type ElicitOutcome = { outcome: 'answered'; response: InputResponse } | { outcome: 'timed_out' };

/**
 * The step API. Step names are the journal keys — unique per task; reusing a
 * name in a single run throws `DuplicateStepError` (loops must suffix an
 * index). All side effects belong inside `step.do`; code between steps must
 * be cheap and deterministic because the whole handler body re-runs on every
 * resume, with completed steps returning persisted results.
 */
export interface Step {
    /**
     * Runs a journaled closure. On replay, a completed step resolves with its
     * persisted result without executing the closure. Return values must be
     * JSON-serializable ({@link JsonSerializable}).
     */
    do<T extends JsonSerializable>(name: string, fn: () => T | Promise<T>): Promise<T>;
    do<T extends JsonSerializable>(name: string, config: StepConfig, fn: () => T | Promise<T>): Promise<T>;

    /**
     * Durable sleep: records the wake time, suspends the invocation, and
     * resumes via the TaskRunner alarm. Never blocks a running invocation.
     * An answer to a standing {@link Step.offer} cuts a pending sleep short
     * (the resumed replay resolves it at once) so the story can react; an
     * answer that lands while the handler is executing cuts the next sleep
     * the handler records instead (it resolves immediately, no suspension).
     */
    sleep(name: string, duration: number | DurationString): Promise<void>;

    /** Durable sleep until an absolute time (ms epoch or Date). */
    sleepUntil(name: string, when: number | Date): Promise<void>;

    /**
     * EXPERIMENTAL (v1, decision D13): records an input request under a
     * lifetime-unique key (the step name), moves the task to `input_required`,
     * and suspends until a `tasks/update` supplies a matching response — the
     * task then returns to `working` and the step resolves with the client's
     * response. Partial responses are accepted; unknown keys are ignored.
     *
     * With an {@link ElicitConfig} carrying `timeoutMs`, the wait is bounded:
     * an unanswered request is resolved as timed out at the deadline and the
     * step resolves with the discriminated {@link ElicitOutcome} instead of a
     * bare response. Without a config, today's wait-forever contract holds.
     */
    elicit(name: string, request: InputRequest): Promise<InputResponse>;
    elicit(name: string, request: InputRequest, config: ElicitConfig): Promise<ElicitOutcome>;

    /**
     * Standing, NON-blocking input channel: registers an input request under a
     * lifetime-unique key (shared with elicit names — a key never repeats
     * within a task) WITHOUT suspending. The task stays `working`, the status
     * is untouched, the story continues; the offer is announced in-story (via
     * `step.status`), never in `tasks/get` `inputRequests` (that field is tied
     * to `input_required` and shows blocking elicits only). A `tasks/update`
     * naming the key stores the first answer (later answers to the key ack and
     * change nothing) and wakes the task at once: a `step.sleep` pending at
     * that moment is cut short so the next {@link Step.checkInput} can consume
     * the answer without waiting for the beat to end; if the handler is
     * executing at that moment, its next `checkInput` consumes the answer, or
     * the next sleep it records is cut instead. (A pending step retry backoff
     * is never pre-empted: the answer is consumed by the retried run.) An
     * outstanding offer never holds the task in `input_required` and never
     * blocks a fork elicit's resume. Journal-safe: re-offering the key on
     * replay is a no-op (the existing offer stands); reusing the key in one
     * run throws `DuplicateStepError`.
     */
    offer(key: string, request: InputRequest): Promise<void>;

    /**
     * Journaled, non-blocking consume of a standing offer: resolves with the
     * offer's answer — marking it consumed, so later checks of the same key
     * resolve `null` — or `null` when no unconsumed answer exists. Never
     * suspends. Each call site is a journaled step under its own unique
     * `name`, and the journaled value stands on replay (an answer that lands
     * after a journaled miss is consumed by the NEXT check, not retroactively
     * by the replay of this one). Throws for a key that is not a registered
     * offer (unknown, or a blocking elicit).
     */
    checkInput(name: string, key: string): Promise<InputResponse | null>;

    /**
     * Durable handler telemetry: writes the task's `statusMessage` so
     * `tasks/get` pollers see it. The handler is the ONLY writer of
     * `statusMessage` — the engine never narrates its own transitions — so the
     * field is absent until the first call, and the last written message
     * stands until the handler writes again, through suspensions, replays, and
     * terminal transitions alike (a completed/failed task keeps its last
     * message next to the stored result/error). A side-effecting convenience,
     * not a journaled step: it creates no journal rows, never disturbs replay
     * ordering, and duplicate delivery on replay is harmless (the re-run
     * handler body rewrites the same message). Calling it after a terminal
     * state is a no-op. Generation-guarded like every lease write: a
     * superseded attempt's call throws and the invocation is abandoned.
     */
    status(message: string): Promise<void>;

    /**
     * The idempotency key for a step — `${taskId}:${stepName}` — to pass to
     * external systems: a crash between an external side effect and the journal
     * commit re-runs exactly that step, so external calls should deduplicate on
     * this key.
     */
    readonly idempotencyKey: (stepName: string) => string;
}
