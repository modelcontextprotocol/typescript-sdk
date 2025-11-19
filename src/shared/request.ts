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

        // For task-based requests, start task polling and race with direct result
        return Promise.allSettled([
            (async () => {
                // Call onTaskCreated immediately since task is created synchronously by tool implementor
                await onTaskCreated();

                // Start task polling
                return await this.taskHandler(this.taskId!, {
                    onTaskCreated,
                    onTaskStatus
                });
            })(),
            this.resultHandle
        ]).then(([task, result]) => {
            if (task.status === 'fulfilled') {
                return task.value;
            } else if (result.status === 'fulfilled') {
                return result.value;
            }

            // Both failed - prefer to throw the result error since it's usually more meaningful
            // (e.g., timeout, connection error, etc.) than the task polling failure
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

            // Handle input_required status: preemptively call tasks/result instead of continuing to poll
            // This allows the receiver to block and wait for user input before returning the result
            if (task.status === 'input_required') {
                return await this.protocol.getTaskResult({ taskId: taskId }, this.resultSchema);
            }

            if (!isTerminal(task.status)) {
                await new Promise(resolve =>
                    setTimeout(resolve, task.pollInterval ?? this.defaultTaskPollInterval ?? DEFAULT_TASK_POLLING_INTERVAL)
                );
            }
        } while (!isTerminal(task.status));

        // Process result
        return await this.protocol.getTaskResult({ taskId: taskId }, this.resultSchema);
    }
}
