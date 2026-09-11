/**
 * `createTaskExecutor` — the engine-neutral half of running a task: resolve
 * the handler from the registration table, wrap the engine's per-attempt
 * journal in the replay-aware `Step`, run the handler, and map how it settled.
 *
 * A handler throw is journaled as a `completed` + `isError` result — exactly
 * what the synchronous tool call would have returned. `failed` is reserved for
 * engine-level errors (unknown task, serialization, an invalid retry policy).
 */

import type { TaskRegistration } from '../server/registration';
import { ReplayStep, SuspendSignal } from '../step/replayStep';
import { ResultSerializationError, RetryPolicyError, serializeError } from './errors';
import type { RunOutcome, StepJournal, TaskExecutor, TaskInvocation } from './protocol';
import { isStaleLeaseError } from './protocol';

/** Where the executor looks handlers up. */
export interface TaskRegistry {
    getTaskRegistration(name: string): TaskRegistration | undefined;
}

/**
 * Builds the executor for a registry. A registry that resolves lazily (for
 * example by constructing a fresh server per invocation) is fine — the lookup
 * happens per `runTask`.
 */
export function createTaskExecutor(registry: TaskRegistry): TaskExecutor {
    return {
        async runTask(invocation: TaskInvocation, journal: StepJournal): Promise<RunOutcome> {
            let registration: TaskRegistration | undefined;
            try {
                registration = registry.getTaskRegistration(invocation.taskName);
            } catch (error) {
                // A throwing registry is an engine failure, not a handler error.
                return { outcome: 'failed', error: serializeError(error) };
            }
            if (registration === undefined) {
                return {
                    outcome: 'failed',
                    error: { name: 'UnknownTaskError', message: `No task named "${invocation.taskName}" is registered` }
                };
            }

            const step = new ReplayStep(journal, invocation.taskId, registration.retries, invocation.attempt);
            try {
                const result = await registration.handler(invocation.input, step);
                return { outcome: 'completed', result };
            } catch (error) {
                if (error instanceof SuspendSignal || isStaleLeaseError(error)) {
                    // Sleep recorded / retry scheduled / input requested /
                    // cancelled — or the attempt was superseded. The engine
                    // already knows why; abandon this attempt.
                    return { outcome: 'suspended' };
                }
                if (error instanceof ResultSerializationError || error instanceof RetryPolicyError) {
                    return { outcome: 'failed', error: serializeError(error) };
                }
                const detail = serializeError(error);
                return {
                    outcome: 'completed',
                    result: { content: [{ type: 'text', text: `${detail.name}: ${detail.message}` }], isError: true }
                };
            }
        }
    };
}
