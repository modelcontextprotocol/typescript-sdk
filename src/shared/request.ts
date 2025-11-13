import { ZodType } from 'zod';
import { Protocol } from './protocol.js';
import { Request, Notification, Result, Task, GetTaskResult } from '../types.js';
import { isTerminal } from './task.js';

const DEFAULT_TASK_POLLING_INTERVAL = 5000;

const DEFAULT_HANDLER = () => Promise.resolve();

export interface TaskHandlerOptions {
    onTaskCreated: () => Promise<void> | void;
    onTaskStatus: (task: Task) => Promise<void> | void;
}

export class PendingRequest<SendRequestT extends Request, SendNotificationT extends Notification, SendResultT extends Result> {
    constructor(
        readonly protocol: Protocol<SendRequestT, SendNotificationT, SendResultT>,
        readonly taskCreatedHandle: Promise<void>,
        readonly resultHandle: Promise<SendResultT>,
        readonly resultSchema: ZodType,
        readonly taskId?: string,
        readonly defaultTaskPollInterval?: number
    ) {}

    /**
     * Waits for a result, calling onTaskStatus if provided and a task was created.
     */
    async result(options?: Partial<TaskHandlerOptions>): Promise<SendResultT> {
        const { onTaskCreated = DEFAULT_HANDLER, onTaskStatus = DEFAULT_HANDLER } = options ?? {};

        if (!this.taskId) {
            // No task ID provided, just block for the result
            return await this.resultHandle;
        }

        // Whichever is successful first (or a failure if all fail) is returned.
        return Promise.allSettled([
            (async () => {
                // Start task handler immediately without waiting for creation notification
                const taskPromise = this.taskHandler(this.taskId!, {
                    onTaskCreated,
                    onTaskStatus
                });

                // Call onTaskCreated callback when notification arrives, but don't block taskHandler
                // The promise is tied to the lifecycle of taskPromise, so it won't leak
                this.taskCreatedHandle
                    .then(() => onTaskCreated())
                    .catch(() => {
                        // Silently ignore if notification never arrives or fails
                    });

                return await taskPromise;
            })(),
            this.resultHandle
        ]).then(([task, result]) => {
            if (task.status === 'fulfilled') {
                return task.value;
            } else if (result.status === 'fulfilled') {
                return result.value;
            }

            // Both failed - prefer to throw the result error since it's usually more meaningful
            // (e.g., timeout, connection error, etc.) than the task creation failure
            throw result.reason;
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
            await new Promise(resolve =>
                setTimeout(resolve, task.pollInterval ?? this.defaultTaskPollInterval ?? DEFAULT_TASK_POLLING_INTERVAL)
            );
        } while (!isTerminal(task.status));

        // Process result
        return await this.protocol.getTaskResult({ taskId: taskId }, this.resultSchema);
    }
}
