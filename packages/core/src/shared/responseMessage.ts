import type { Result, Task } from '../types/types.js';

/**
 * Base message type
 */
export interface BaseResponseMessage {
    type: string;
}

/**
 * Task status update message
 */
export interface TaskStatusMessage extends BaseResponseMessage {
    type: 'taskStatus';
    task: Task;
}

/**
 * Task created message (first message for task-augmented requests)
 */
export interface TaskCreatedMessage extends BaseResponseMessage {
    type: 'taskCreated';
    task: Task;
}

/**
 * Final result message (terminal)
 */
export interface ResultMessage<T extends Result> extends BaseResponseMessage {
    type: 'result';
    result: T;
}

/**
 * Error message (terminal)
 */
export interface ErrorMessage extends BaseResponseMessage {
    type: 'error';
    error: Error;
}

/**
 * Union type representing all possible messages that can be yielded during request processing.
 * Note: Progress notifications are handled through the existing onprogress callback mechanism.
 * Side-channeled messages (server requests/notifications) are handled through registered handlers.
 */
export type ResponseMessage<T extends Result> = TaskStatusMessage | TaskCreatedMessage | ResultMessage<T> | ErrorMessage;

export type AsyncGeneratorValue<T> = T extends AsyncGenerator<infer U> ? U : never;

export async function toArrayAsync<T extends AsyncGenerator<unknown>>(it: T): Promise<AsyncGeneratorValue<T>[]> {
    const arr: AsyncGeneratorValue<T>[] = [];
    for await (const o of it) {
        arr.push(o as AsyncGeneratorValue<T>);
    }

    return arr;
}

export async function takeResult<T extends Result, U extends AsyncGenerator<ResponseMessage<T>>>(it: U): Promise<T> {
    for await (const o of it) {
        if (o.type === 'result') {
            return o.result;
        } else if (o.type === 'error') {
            throw o.error;
        }
    }

    throw new Error('No result in stream.');
}
