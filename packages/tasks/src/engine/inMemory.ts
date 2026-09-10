/**
 * `InMemoryTaskEngine` — the reference {@link TaskEngine}: task records and
 * step journals in a `Map`, one timer per task computed from the rows (the
 * same "the alarm is derived, never stored" shape a durable engine uses), and
 * handlers run in-process through the attached executor.
 *
 * Suitable for tests, single-process servers, and as the model for a durable
 * engine: every method here maps one-to-one onto a row write a persistent
 * store would make. State does not survive the process.
 */

import type { CallToolResult, InputRequests, InputResponses } from '@modelcontextprotocol/server';

import type { DetailedTask, Task, TaskStatus } from '../wire/types';
import type { SerializedError } from './errors';
import { DuplicateStepError } from './errors';
import type {
    BeginStepOptions,
    BeginStepResult,
    CheckInputState,
    ElicitState,
    SleepState,
    StepFailureDisposition,
    StepJournal,
    TaskExecutor
} from './protocol';
import { StaleLeaseError } from './protocol';
import type { CreateTaskParams, TaskAccess, TaskEngine } from './taskEngine';

interface StepRow {
    status: 'pending' | 'completed' | 'failed';
    attempt: number;
    nextAttemptAt: number;
    value?: unknown;
    error?: SerializedError;
}

interface SleepRow {
    seq: number;
    wakeAt: number;
    completed: boolean;
}

interface InputRow {
    seq: number;
    request: unknown;
    blocking: boolean;
    answered: boolean;
    timedOut: boolean;
    consumed: boolean;
    response?: unknown;
    timeoutAt?: number;
}

interface TaskRecord {
    taskId: string;
    taskName: string;
    input: unknown;
    principal?: string;
    status: TaskStatus;
    statusMessage?: string;
    createdAt: number;
    lastUpdatedAt: number;
    ttlMs: number | null;
    pollIntervalMs: number;
    result?: CallToolResult;
    error?: SerializedError;
    cancelRequested: boolean;
    /** Run attempt counter (claims). */
    attempt: number;
    /** Generation of the attempt that currently owns the journal. */
    generation: number;
    running: boolean;
    /** Earliest time the next run is due, or `undefined` when nothing is pending. */
    runNextAt: number | undefined;
    /** An offer answer landed mid-run: the next recorded sleep resolves at once. */
    cutNextSleep: boolean;
    seq: number;
    steps: Map<string, StepRow>;
    sleeps: Map<string, SleepRow>;
    inputs: Map<string, InputRow>;
    checks: Map<string, CheckInputState>;
    timer: ReturnType<typeof setTimeout> | undefined;
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'cancelled']);

/** Options for {@link InMemoryTaskEngine}. */
export interface InMemoryTaskEngineOptions {
    /** Task id factory. Default `crypto.randomUUID()`. */
    createTaskId?: () => string;
    /** Clock, for tests. Default `Date.now`. */
    now?: () => number;
}

export class InMemoryTaskEngine implements TaskEngine {
    readonly #tasks = new Map<string, TaskRecord>();
    readonly #createTaskId: () => string;
    readonly #now: () => number;
    #executor: TaskExecutor | undefined;

    constructor(options?: InMemoryTaskEngineOptions) {
        this.#createTaskId = options?.createTaskId ?? (() => crypto.randomUUID());
        this.#now = options?.now ?? (() => Date.now());
    }

    attach(executor: TaskExecutor): void {
        this.#executor = executor;
    }

    /** Clears every timer and forgets every task. For tests and shutdown. */
    close(): void {
        for (const record of this.#tasks.values()) {
            if (record.timer !== undefined) clearTimeout(record.timer);
        }
        this.#tasks.clear();
    }

    async create(params: CreateTaskParams): Promise<Task> {
        if (params.ttlMs !== null && (!Number.isSafeInteger(params.ttlMs) || params.ttlMs < 0)) {
            throw new RangeError(`ttlMs must be a non-negative integer or null, got ${params.ttlMs}`);
        }
        if (!Number.isSafeInteger(params.pollIntervalMs) || params.pollIntervalMs < 0) {
            throw new RangeError(`pollIntervalMs must be a non-negative integer, got ${params.pollIntervalMs}`);
        }
        const now = this.#now();
        const record: TaskRecord = {
            taskId: this.#createTaskId(),
            taskName: params.taskName,
            input: params.input,
            ...(params.principal !== undefined && { principal: params.principal }),
            status: 'working',
            createdAt: now,
            lastUpdatedAt: now,
            ttlMs: params.ttlMs,
            pollIntervalMs: params.pollIntervalMs,
            cancelRequested: false,
            attempt: 0,
            generation: 0,
            running: false,
            runNextAt: now,
            cutNextSleep: false,
            seq: 0,
            steps: new Map(),
            sleeps: new Map(),
            inputs: new Map(),
            checks: new Map(),
            timer: undefined
        };
        this.#tasks.set(record.taskId, record);
        this.#reconcile(record);
        return this.#baseSnapshot(record);
    }

    async get(taskId: string, access?: TaskAccess): Promise<DetailedTask | undefined> {
        const record = this.#lookup(taskId, access);
        return record === undefined ? undefined : this.#detailedSnapshot(record);
    }

    async update(taskId: string, inputResponses: InputResponses, access?: TaskAccess): Promise<boolean> {
        const record = this.#lookup(taskId, access);
        if (record === undefined) return false;
        if (TERMINAL.has(record.status)) return true;
        let wake = false;
        for (const [key, response] of Object.entries(inputResponses)) {
            const row = record.inputs.get(key);
            // Unknown keys are ignored; the first answer to a key wins.
            if (row === undefined || row.answered) continue;
            row.answered = true;
            row.response = response;
            wake = true;
            if (!row.blocking) {
                // An offer answer cuts a pending sleep short so the handler
                // can react; mid-run, the next recorded sleep is cut instead.
                if (record.running) {
                    record.cutNextSleep = true;
                } else {
                    for (const sleep of record.sleeps.values()) {
                        if (!sleep.completed) sleep.completed = true;
                    }
                }
            }
        }
        if (!wake) return true;
        this.#touch(record);
        if (this.#outstandingBlocking(record).length === 0) {
            record.status = 'working';
            record.runNextAt = this.#now();
        }
        this.#reconcile(record);
        return true;
    }

    async cancel(taskId: string, access?: TaskAccess): Promise<boolean> {
        const record = this.#lookup(taskId, access);
        if (record === undefined) return false;
        if (TERMINAL.has(record.status)) return true;
        record.cancelRequested = true;
        if (!record.running) {
            // Nothing is executing: settle now instead of waiting for a wake.
            this.#settle(record, 'cancelled');
        }
        return true;
    }

    // ------------------------------------------------------------ scheduling --

    #lookup(taskId: string, access: TaskAccess | undefined): TaskRecord | undefined {
        const record = this.#tasks.get(taskId);
        if (record === undefined) return undefined;
        if (record.principal !== undefined && record.principal !== access?.principal) return undefined;
        return record;
    }

    #touch(record: TaskRecord): void {
        record.lastUpdatedAt = this.#now();
    }

    #outstandingBlocking(record: TaskRecord): Array<[string, InputRow]> {
        return [...record.inputs].filter(([, row]) => row.blocking && !row.answered);
    }

    #ttlDeadline(record: TaskRecord): number | undefined {
        return record.ttlMs === null ? undefined : record.createdAt + record.ttlMs;
    }

    /** The earliest pending wake among step retries and sleeps, plus `runNextAt`. */
    #earliestExecutionWake(record: TaskRecord): number | undefined {
        const candidates: number[] = [];
        if (record.runNextAt !== undefined) candidates.push(record.runNextAt);
        for (const step of record.steps.values()) {
            if (step.status === 'pending' && step.attempt > 0) candidates.push(step.nextAttemptAt);
        }
        for (const sleep of record.sleeps.values()) {
            if (!sleep.completed) candidates.push(sleep.wakeAt);
        }
        return candidates.length === 0 ? undefined : Math.min(...candidates);
    }

    #earliestElicitDeadline(record: TaskRecord): number | undefined {
        const deadlines = this.#outstandingBlocking(record)
            .map(([, row]) => row.timeoutAt)
            .filter((value): value is number => value !== undefined);
        return deadlines.length === 0 ? undefined : Math.min(...deadlines);
    }

    /** Recomputes the single timer from the rows. Runs after every scheduling-relevant write. */
    #reconcile(record: TaskRecord): void {
        if (record.timer !== undefined) {
            clearTimeout(record.timer);
            record.timer = undefined;
        }
        const candidates: number[] = [];
        const ttl = this.#ttlDeadline(record);
        if (ttl !== undefined) candidates.push(ttl);
        if (!TERMINAL.has(record.status) && !record.running) {
            const wake = record.status === 'input_required' ? undefined : this.#earliestExecutionWake(record);
            if (wake !== undefined) candidates.push(wake);
            const deadline = this.#earliestElicitDeadline(record);
            if (deadline !== undefined) candidates.push(deadline);
        }
        if (candidates.length === 0) return;
        const delay = Math.max(0, Math.min(...candidates) - this.#now());
        record.timer = setTimeout(() => {
            record.timer = undefined;
            void this.#tick(record);
        }, delay);
        record.timer.unref?.();
    }

    async #tick(record: TaskRecord): Promise<void> {
        const now = this.#now();
        const ttl = this.#ttlDeadline(record);
        if (ttl !== undefined && ttl <= now) {
            this.#tasks.delete(record.taskId);
            return;
        }
        if (TERMINAL.has(record.status) || record.running) {
            this.#reconcile(record);
            return;
        }
        // Elicit deadlines that elapsed: answered-by-timeout, back to working.
        let resumed = false;
        for (const row of this.#outstandingBlocking(record).map(([, row]) => row)) {
            if (row.timeoutAt !== undefined && row.timeoutAt <= now) {
                row.answered = true;
                row.timedOut = true;
                resumed = true;
            }
        }
        if (resumed && this.#outstandingBlocking(record).length === 0) {
            record.status = 'working';
            record.runNextAt = now;
            this.#touch(record);
        }
        if (record.status === 'working') {
            const wake = this.#earliestExecutionWake(record);
            if (wake !== undefined && wake <= now) {
                await this.#run(record);
                return;
            }
        }
        this.#reconcile(record);
    }

    async #run(record: TaskRecord): Promise<void> {
        const executor = this.#executor;
        if (executor === undefined) {
            this.#settle(record, 'failed', { name: 'EngineNotAttached', message: 'No task executor is attached to the engine' });
            return;
        }
        record.running = true;
        record.runNextAt = undefined;
        record.attempt += 1;
        record.generation += 1;
        const generation = record.generation;
        const journal = this.#journal(record, generation);
        let outcome;
        try {
            outcome = await executor.runTask(
                { taskId: record.taskId, taskName: record.taskName, input: record.input, attempt: record.attempt },
                journal
            );
        } catch (error) {
            outcome = { outcome: 'failed' as const, error: { name: 'ExecutorError', message: String(error) } };
        }
        if (record.generation !== generation || !this.#tasks.has(record.taskId)) return; // superseded or purged
        record.running = false;
        switch (outcome.outcome) {
            case 'completed': {
                this.#settle(record, 'completed', undefined, outcome.result);
                return;
            }
            case 'failed': {
                this.#settle(record, 'failed', outcome.error);
                return;
            }
            case 'suspended': {
                if (record.cancelRequested) {
                    this.#settle(record, 'cancelled');
                    return;
                }
                if (this.#outstandingBlocking(record).length > 0) {
                    record.status = 'input_required';
                    this.#touch(record);
                }
                this.#reconcile(record);
            }
        }
    }

    #settle(record: TaskRecord, status: 'completed' | 'failed' | 'cancelled', error?: SerializedError, result?: CallToolResult): void {
        record.status = status;
        record.running = false;
        record.runNextAt = undefined;
        if (result !== undefined) record.result = result;
        if (error !== undefined) record.error = error;
        this.#touch(record);
        this.#reconcile(record);
    }

    // --------------------------------------------------------------- journal --

    #journal(record: TaskRecord, generation: number): StepJournal {
        const guard = (): void => {
            if (!this.#tasks.has(record.taskId)) throw new StaleLeaseError(record.taskId, 'task purged');
            if (record.generation !== generation) throw new StaleLeaseError(record.taskId, 'attempt superseded');
            if (TERMINAL.has(record.status)) throw new StaleLeaseError(record.taskId, `task is ${record.status}`);
        };
        const latestSuspension = (): string | undefined => {
            let best: { key: string; seq: number } | undefined;
            for (const [key, row] of record.sleeps) {
                if (best === undefined || row.seq > best.seq) best = { key, seq: row.seq };
            }
            for (const [key, row] of record.inputs) {
                if (row.blocking && (best === undefined || row.seq > best.seq)) best = { key, seq: row.seq };
            }
            return best?.key;
        };
        const now = this.#now;
        return {
            taskId: record.taskId,
            attempt: record.attempt,
            async beginStep(stepKey: string, _options?: BeginStepOptions): Promise<BeginStepResult> {
                guard();
                if (record.cancelRequested) return { state: 'cancelled' };
                const row = record.steps.get(stepKey);
                if (row === undefined) {
                    record.steps.set(stepKey, { status: 'pending', attempt: 1, nextAttemptAt: now() });
                    return { state: 'run', attempt: 1 };
                }
                if (row.status === 'completed') return { state: 'completed', value: row.value };
                if (row.status === 'failed') return { state: 'failed', error: row.error ?? { name: 'Error', message: 'step failed' } };
                row.attempt += 1;
                return { state: 'run', attempt: row.attempt };
            },
            async completeStep(stepKey: string, value: unknown): Promise<boolean> {
                guard();
                const row = record.steps.get(stepKey);
                if (row === undefined || row.status !== 'pending') return false;
                row.status = 'completed';
                row.value = value;
                return true;
            },
            async failStep(stepKey: string, error: SerializedError, disposition: StepFailureDisposition): Promise<boolean> {
                guard();
                const row = record.steps.get(stepKey);
                if (row === undefined || row.status !== 'pending') return false;
                row.error = error;
                if ('terminal' in disposition) {
                    row.status = 'failed';
                } else {
                    row.nextAttemptAt = disposition.retryAtMs;
                }
                return true;
            },
            async recordSleep(stepKey: string, wakeAtMs: number): Promise<SleepState> {
                guard();
                let row = record.sleeps.get(stepKey);
                if (row === undefined) {
                    row = { seq: ++record.seq, wakeAt: wakeAtMs, completed: false };
                    record.sleeps.set(stepKey, row);
                    if (record.cutNextSleep) {
                        record.cutNextSleep = false;
                        row.completed = true;
                        return { state: 'completed', latest: true };
                    }
                    if (wakeAtMs > now()) return { state: 'pending' };
                    row.completed = true;
                    return { state: 'completed', latest: true };
                }
                if (!row.completed) {
                    if (row.wakeAt > now()) return { state: 'pending' };
                    row.completed = true;
                }
                return { state: 'completed', latest: latestSuspension() === stepKey };
            },
            async recordElicit(stepKey: string, request: unknown, timeoutAtMs?: number): Promise<ElicitState> {
                guard();
                let row = record.inputs.get(stepKey);
                if (row === undefined) {
                    row = {
                        seq: ++record.seq,
                        request,
                        blocking: true,
                        answered: false,
                        timedOut: false,
                        consumed: false,
                        ...(timeoutAtMs !== undefined && { timeoutAt: timeoutAtMs })
                    };
                    record.inputs.set(stepKey, row);
                    return { state: 'pending' };
                }
                if (!row.blocking) throw new DuplicateStepError(stepKey);
                if (!row.answered) return { state: 'pending' };
                const latest = latestSuspension() === stepKey;
                return row.timedOut ? { state: 'timed_out', latest } : { state: 'answered', response: row.response, latest };
            },
            async recordOffer(key: string, request: unknown): Promise<void> {
                guard();
                const row = record.inputs.get(key);
                if (row !== undefined) {
                    if (row.blocking) throw new DuplicateStepError(key);
                    return; // replay: the first recorded offer stands
                }
                record.inputs.set(key, {
                    seq: ++record.seq,
                    request,
                    blocking: false,
                    answered: false,
                    timedOut: false,
                    consumed: false
                });
            },
            async checkInput(stepKey: string, key: string): Promise<CheckInputState> {
                guard();
                const journaled = record.checks.get(stepKey);
                if (journaled !== undefined) return journaled;
                const row = record.inputs.get(key);
                if (row === undefined || row.blocking) {
                    throw new Error(`step.checkInput("${stepKey}"): "${key}" is not a registered offer`);
                }
                const state: CheckInputState =
                    row.answered && !row.consumed ? { state: 'answered', response: row.response } : { state: 'unanswered' };
                if (state.state === 'answered') row.consumed = true;
                record.checks.set(stepKey, state);
                return state;
            },
            async setStatus(message: string): Promise<void> {
                guard();
                record.statusMessage = message;
                record.lastUpdatedAt = now();
            },
            async checkCancel(): Promise<boolean> {
                guard();
                return record.cancelRequested;
            }
        };
    }

    // ------------------------------------------------------------- snapshots --

    #baseSnapshot(record: TaskRecord): Task {
        return {
            taskId: record.taskId,
            status: record.status,
            ...(record.statusMessage !== undefined && { statusMessage: record.statusMessage }),
            createdAt: new Date(record.createdAt).toISOString(),
            lastUpdatedAt: new Date(record.lastUpdatedAt).toISOString(),
            ttlMs: record.ttlMs,
            pollIntervalMs: record.pollIntervalMs
        };
    }

    #detailedSnapshot(record: TaskRecord): DetailedTask {
        const base = this.#baseSnapshot(record);
        switch (record.status) {
            case 'working': {
                return { ...base, status: 'working' };
            }
            case 'input_required': {
                const inputRequests: InputRequests = {};
                for (const [key, row] of this.#outstandingBlocking(record)) {
                    inputRequests[key] = row.request as InputRequests[string];
                }
                return { ...base, status: 'input_required', inputRequests };
            }
            case 'completed': {
                return { ...base, status: 'completed', result: (record.result ?? { content: [] }) as { [key: string]: unknown } };
            }
            case 'failed': {
                return {
                    ...base,
                    status: 'failed',
                    error: { code: -32_603, message: record.error?.message ?? 'Task failed', data: { name: record.error?.name } }
                };
            }
            case 'cancelled': {
                return { ...base, status: 'cancelled' };
            }
        }
    }
}
