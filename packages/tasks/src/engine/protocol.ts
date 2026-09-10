/**
 * The engine <-> executor protocol: the shapes that cross between whatever
 * runs a task's handler (the executor, built from the task registrations) and
 * whatever owns the task's durable state (the engine). Kept in one module so
 * engines and the executor share them without importing each other.
 *
 * Everything here must survive structured serialization: plain JSON in, plain
 * JSON out. The one capability that crosses as an object is the per-attempt
 * {@link StepJournal}, the surface the replay-aware step API drives.
 */

import type { CallToolResult } from '@modelcontextprotocol/server';

import type { SerializedError } from './errors';

/** One claimed execution attempt, as dispatched by the engine. */
export interface TaskInvocation {
    taskId: string;
    taskName: string;
    input: unknown;
    /** The task-level claim counter (`1` for the first run). */
    attempt: number;
}

/** How a `runTask` invocation settled. */
export type RunOutcome =
    /** The handler returned; the engine persists the result and completes the task. */
    | { outcome: 'completed'; result: CallToolResult }
    /** Sleep recorded / step retry scheduled / input requested / cancelled — the engine already knows why. */
    | { outcome: 'suspended' }
    /** Engine-level failure only (e.g. unknown task) — never a handler throw. */
    | { outcome: 'failed'; error: SerializedError };

/** Directive returned by `beginStep`: what the executor should do with a step. */
export type BeginStepResult =
    /** Journal miss (or pending retry): run the closure as this step attempt. */
    | { state: 'run'; attempt: number }
    /** Journal hit: the persisted result, closure MUST NOT run. */
    | { state: 'completed'; value: unknown }
    /** The step already failed terminally in an earlier attempt. */
    | { state: 'failed'; error: SerializedError }
    /** Cancellation was requested: abort the invocation (suspend). */
    | { state: 'cancelled' };

/**
 * State of a journaled sleep after `recordSleep`.
 *
 * `latest` on a completed sleep / resolved elicit: this row is the LAST
 * suspension point the previous run recorded. A resumed handler replays
 * earlier suspension points as plain hits; the latest one is where it goes
 * back on new ground (and `step.status` starts writing again).
 */
export type SleepState = { state: 'pending' } | { state: 'completed'; latest: boolean };

/**
 * State of an input request after `recordElicit`. `timed_out` means the
 * request's deadline elapsed unanswered: the engine marked it
 * answered-by-timeout (late `tasks/update` responses to the key are ignored)
 * and the replay resolves the elicit with a timeout outcome instead of a
 * response.
 */
export type ElicitState =
    | { state: 'pending' }
    | { state: 'answered'; response: unknown; latest: boolean }
    | { state: 'timed_out'; latest: boolean };

/**
 * Result of a journaled `checkInput` against a standing (non-blocking) offer:
 * the offer's answer, consumed by this step (or journaled by it earlier —
 * replays observe the same value), or nothing to consume. Never suspends.
 */
export type CheckInputState = { state: 'answered'; response: unknown } | { state: 'unanswered' };

/** How a failed `step.do` attempt should be disposed of. */
export type StepFailureDisposition =
    /** Retry: the engine redelivers at `retryAtMs` (the executor computed the backoff). */
    | { retryAtMs: number }
    /** Terminal: no further attempts; the step is marked `failed`. */
    | { terminal: true };

/** Options recorded when a `do` step first enters the journal. */
export interface BeginStepOptions {
    /** Per-attempt closure timeout, ms (journaled for observability). */
    timeoutMs?: number;
}

/**
 * The per-attempt journal an engine hands to `runTask`: constructed for
 * exactly one execution attempt, every write is guarded by that attempt's
 * generation. A superseded attempt's calls throw {@link StaleLeaseError}.
 * Handler code never sees it — the replay-aware `Step` wraps it.
 */
export interface StepJournal {
    /** The task this attempt belongs to. */
    readonly taskId: string;
    /** The claim counter of the attempt this journal was minted for. */
    readonly attempt: number;
    beginStep(stepKey: string, options?: BeginStepOptions): Promise<BeginStepResult>;
    completeStep(stepKey: string, value: unknown): Promise<boolean>;
    failStep(stepKey: string, error: SerializedError, disposition: StepFailureDisposition): Promise<boolean>;
    recordSleep(stepKey: string, wakeAtMs: number): Promise<SleepState>;
    /**
     * Journals an input request. `timeoutAtMs` (ms epoch) is the answer
     * deadline, stored with the request on first record and immutable across
     * replays — recomputed deadlines from later invocations are ignored.
     * Omitted = no deadline (waits forever).
     */
    recordElicit(stepKey: string, request: unknown, timeoutAtMs?: number): Promise<ElicitState>;
    /**
     * Registers a standing, NON-blocking input request (`step.offer`) under a
     * lifetime-unique key without suspending: the task stays `working` and
     * the offer never appears in `tasks/get` `inputRequests`. Journal-safe: a
     * replay's re-offer of the same key finds the existing row. A key already
     * used by a blocking elicit throws `DuplicateStepError`.
     */
    recordOffer(key: string, request: unknown): Promise<void>;
    /**
     * Journaled, non-blocking consume (`step.checkInput`) of the offer under
     * `key`, as the step named `stepKey`: an unconsumed answer is returned and
     * marked consumed; otherwise the step journals a miss. Either outcome is
     * journaled under `stepKey`, so a replay observes the same value. Throws
     * for a key that is not a registered offer.
     */
    checkInput(stepKey: string, key: string): Promise<CheckInputState>;
    /**
     * Durable handler telemetry (`step.status`): writes the task's
     * `statusMessage`. The handler is the single writer — the engine never
     * narrates its own transitions. Not a journal write: replays may deliver
     * the same message again, harmlessly. A no-op once the task is terminal.
     */
    setStatus(message: string): Promise<void>;
    checkCancel(): Promise<boolean>;
}

/**
 * The executor surface an engine dispatches to: runs one attempt of a task's
 * handler against a journal and reports how it settled. Built from the task
 * registrations by `createTaskExecutor`; engines that run handlers in-process
 * receive it through `TaskEngine.attach`.
 */
export interface TaskExecutor {
    runTask(invocation: TaskInvocation, journal: StepJournal): Promise<RunOutcome>;
}

/**
 * Thrown by journal methods when the calling attempt no longer owns the task
 * — its generation was superseded by a newer claim, the task reached a
 * terminal state, or the task was purged. The executor abandons the attempt;
 * the engine re-drives with a fresh journal.
 */
export class StaleLeaseError extends Error {
    constructor(taskId: string, detail: string) {
        super(`Stale lease for task "${taskId}": ${detail}`);
        this.name = 'StaleLeaseError';
    }
}

/**
 * Duck-typed {@link StaleLeaseError} check for the executor side of an RPC
 * boundary: matches an instance, the preserved `name`, or the distinctive
 * message prefix (whichever survives serialization), defensively against
 * hostile getters.
 */
export const isStaleLeaseError = (error: unknown): boolean => {
    if (error instanceof StaleLeaseError) {
        return true;
    }
    if ((typeof error !== 'object' && typeof error !== 'function') || error === null) {
        return false;
    }
    try {
        if (Reflect.get(error, 'name') === 'StaleLeaseError') {
            return true;
        }
        const message = Reflect.get(error, 'message');
        return typeof message === 'string' && message.startsWith('Stale lease for task');
    } catch {
        return false;
    }
};
