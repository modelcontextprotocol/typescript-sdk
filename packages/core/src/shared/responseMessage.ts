import type { Result } from '../types/index.js';

/**
 * Base message type for the response stream.
 */
export interface BaseResponseMessage {
    type: string;
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
 * Union of all message types yielded by streaming APIs.
 *
 * A stream yields either a `result` (success) or `error` (failure) — both terminal.
 */
export type ResponseMessage<T extends Result> = ResultMessage<T> | ErrorMessage;

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
 * Consumes a {@linkcode ResponseMessage} stream and returns the final result.
 * Throws if an `error` message is received or the stream ends without a result.
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
