import type { Writable } from 'node:stream';

import type { JSONRPCMessage } from '../types/index';
import { JSONRPCMessageSchema } from '../types/index';

export const STDIO_DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/**
 * Buffers a continuous stdio stream into discrete JSON-RPC messages.
 */
export class ReadBuffer {
    private _buffer?: Buffer;
    private _maxBufferSize: number;

    constructor(options?: { maxBufferSize?: number }) {
        this._maxBufferSize = options?.maxBufferSize ?? STDIO_DEFAULT_MAX_BUFFER_SIZE;
    }

    append(chunk: Buffer): void {
        const newSize = (this._buffer?.length ?? 0) + chunk.length;
        if (newSize > this._maxBufferSize) {
            this.clear();
            throw new Error(`ReadBuffer exceeded maximum size of ${this._maxBufferSize} bytes`);
        }
        this._buffer = this._buffer ? Buffer.concat([this._buffer, chunk]) : chunk;
    }

    readMessage(): JSONRPCMessage | null {
        while (this._buffer) {
            const index = this._buffer.indexOf('\n');
            if (index === -1) {
                return null;
            }

            const line = this._buffer.toString('utf8', 0, index).replace(/\r$/, '');
            this._buffer = this._buffer.subarray(index + 1);

            try {
                return deserializeMessage(line);
            } catch (error) {
                // Skip non-JSON lines (e.g., debug output from hot-reload tools like
                // tsx or nodemon that write to stdout). Schema validation errors still
                // throw so malformed-but-valid-JSON messages surface via onerror.
                if (error instanceof SyntaxError) {
                    continue;
                }
                throw error;
            }
        }
        return null;
    }

    clear(): void {
        this._buffer = undefined;
    }
}

export function deserializeMessage(line: string): JSONRPCMessage {
    return JSONRPCMessageSchema.parse(JSON.parse(line));
}

export function serializeMessage(message: JSONRPCMessage): string {
    return JSON.stringify(message) + '\n';
}

/**
 * Shared backpressure wait for a writable stream.
 *
 * Registers at most one 'drain' listener at a time no matter how many writes
 * are waiting for the stream to drain. Node and Bun emit
 * MaxListenersExceededWarning once more than 10 listeners pile up on a single
 * event, which previously happened whenever several messages were written
 * while the pipe was backed up (e.g. a slow-starting child process, or bulk
 * notifications like sendToolListChanged).
 */
export class DrainWait {
    private _pending: Promise<void> | null = null;
    private _stream: Writable | null = null;

    /**
     * Returns a promise that resolves when the stream emits 'drain'. All
     * callers that overlap on the same stream share one listener and one
     * promise. Rejects if the stream emits 'error' or 'close' before
     * draining.
     */
    wait(stream: Writable): Promise<void> {
        // The cached wait is only valid for the stream it was created for.
        // A transport can wrap a new stream after a close/start cycle, and a
        // promise bound to a dead stream must not resolve a later send.
        if (this._pending && this._stream === stream) {
            return this._pending;
        }
        if (stream.destroyed) {
            return Promise.reject(new Error('Cannot wait for drain: stream is already destroyed'));
        }

        this._stream = stream;
        this._pending = new Promise<void>((resolve, reject) => {
            const onDrain = () => {
                cleanup();
                resolve();
            };
            const onError = (error: Error) => {
                cleanup();
                reject(error);
            };
            // destroy() without an error emits 'close', never 'error' or
            // 'drain', so waiters would otherwise hang forever.
            const onClose = () => {
                cleanup();
                reject(new Error('Stream closed before it drained'));
            };
            const cleanup = () => {
                stream.off('drain', onDrain);
                stream.off('error', onError);
                stream.off('close', onClose);
                // clear before waiters resume in their microtasks, so a caller
                // that writes again in the same turn gets a fresh listener
                // rather than a settled promise
                if (this._stream === stream) {
                    this._pending = null;
                    this._stream = null;
                }
            };
            stream.once('drain', onDrain);
            stream.once('error', onError);
            stream.once('close', onClose);
        });
        return this._pending;
    }
}
