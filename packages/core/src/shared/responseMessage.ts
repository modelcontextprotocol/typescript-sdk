import type { Result, Task } from '../types/types.js';

/**
 * Base message type for the response stream.
 */
export interface BaseResponseMessage {
    type: string;
}

/**
 * Task status update message.
 *
 * Yielded on each poll iteration while the task is active (e.g. while
 * `working`). May be emitted multiple times with the same status.
 */
export interface TaskStatusMessage extends BaseResponseMessage {
    type: 'taskStatus';
    task: Task;
}

/**
 * Task created message.
 *
 * Yielded once when the server creates a new task for a long-running operation.
 * This is always the first message for task-augmented requests.
 */
export interface TaskCreatedMessage extends BaseResponseMessage {
    type: 'taskCreated';
    task: Task;
}

/**
 * Final result message.
 *
 * Yielded once when the operation completes successfully. Terminal — no further
 * messages will follow.
 */
export interface ResultMessage<T extends Result> extends BaseResponseMessage {
    type: 'result';
    result: T;
}

/**
 * Error message.
 *
 * Yielded once if the operation fails. Terminal — no further messages will follow.
 */
export interface ErrorMessage extends BaseResponseMessage {
    type: 'error';
    error: Error;
}

/**
 * Union of all message types yielded by task-aware streaming APIs such as
 * {@linkcode @modelcontextprotocol/client!experimental/tasks/client.ExperimentalClientTasks#callToolStream | callToolStream()},
 * {@linkcode @modelcontextprotocol/client!experimental/tasks/client.ExperimentalClientTasks#requestStream | ExperimentalClientTasks.requestStream()}, and
 * {@linkcode @modelcontextprotocol/server!experimental/tasks/server.ExperimentalServerTasks#requestStream | ExperimentalServerTasks.requestStream()}.
 *
 * A typical sequence is:
 * 1. `taskCreated` — task is registered (once)
 * 2. `taskStatus`  — zero or more progress updates
 * 3. `result` **or** `error` — terminal message (once)
 *
 * Progress notifications are handled through the existing {@linkcode index.RequestOptions | onprogress} callback.
 * Side-channeled messages (server requests/notifications) are handled through registered handlers.
 */
export type ResponseMessage<T extends Result> = TaskStatusMessage | TaskCreatedMessage | ResultMessage<T> | ErrorMessage;

export type AsyncGeneratorValue<T> = T extends AsyncGenerator<infer U> ? U : never;

/**
 * Collects all values from an async generator into an array.
 */
export async function toArrayAsync<T extends AsyncGenerator<unknown>>(it: T): Promise<AsyncGeneratorValue<T>[]> {
    const arr: AsyncGeneratorValue<T>[] = [];
    for await (const o of it) {
        arr.push(o as AsyncGeneratorValue<T>);
    }

    return arr;
}

/**
 * Consumes a {@linkcode ResponseMessage} stream and returns the final result,
 * discarding intermediate `taskCreated` and `taskStatus` messages. Throws
 * if an `error` message is received or the stream ends without a result.
 */
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
