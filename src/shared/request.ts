import { ZodType } from 'zod';
import { Protocol } from './protocol.js';
import { Request, Notification, Result, Task, GetTaskResult } from '../types.js';

const DEFAULT_POLLING_INTERNAL = 5000;

export interface TaskHandlerOptions {
    onTaskStatus: (task: Task) => Promise<void>;
}

export class PendingRequest<SendRequestT extends Request, SendNotificationT extends Notification, SendResultT extends Result> {
    constructor(
        readonly protocol: Protocol<SendRequestT, SendNotificationT, SendResultT>,
        readonly resultHandle: Promise<SendResultT>,
        readonly resultSchema: ZodType,
        readonly taskId?: string
    ) {}

    /**
     * Waits for a result, calling onTaskStatus if provided and a task was created.
     */
    async result(options?: Partial<TaskHandlerOptions>): Promise<SendResultT> {
        if (!options?.onTaskStatus || !this.taskId) {
            // No task listener or task ID provided, just block for the result
            return await this.resultHandle;
        }

        // Whichever is successful first (or a failure if all fail) is returned.
        return Promise.allSettled([
            this.resultHandle,
            (async () => {
                // Blocks for a notifications/tasks/created with the provided task ID
                await this.protocol.waitForTaskCreation(this.taskId!);
                return await this.taskHandler(this.taskId!, options as TaskHandlerOptions);
            })()
        ]).then(([result, task]) => {
            if (result.status === 'fulfilled') {
                return result.value;
            } else if (task.status === 'fulfilled') {
                return task.value;
            }

            const errors: unknown[] = [result.reason, task.reason];
            throw new Error(`Both request and task handler failed: ${errors.map(e => `${e}`).join(', ')}`);
        });
    }

    /**
     * Encapsulates polling for a result, calling onTaskStatus after querying the task.
     */
    private async taskHandler(taskId: string, { onTaskStatus }: TaskHandlerOptions): Promise<SendResultT> {
        // Poll for completion
        let task: GetTaskResult;
        do {
            task = await this.protocol.getTask({ taskId: taskId });
            await onTaskStatus(task);
            await new Promise(resolve => setTimeout(resolve, task.pollFrequency ?? DEFAULT_POLLING_INTERNAL));
        } while (!(['complete', 'failed', 'cancelled', 'unknown'] as (typeof task.status)[]).includes(task.status));

        // Process result
        return await this.protocol.getTaskResult({ taskId: taskId }, this.resultSchema);
    }
}
