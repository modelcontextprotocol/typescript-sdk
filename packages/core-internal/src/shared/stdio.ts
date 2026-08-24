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

    /**
     * Returns a promise that resolves when the stream emits 'drain'. All
     * callers that overlap share one listener and one promise. Rejects if the
     * stream emits 'error' before draining.
     */
    wait(stream: Writable): Promise<void> {
        if (!this._pending) {
            this._pending = new Promise<void>((resolve, reject) => {
                const onDrain = () => {
                    cleanup();
                    resolve();
                };
                const onError = (error: Error) => {
                    cleanup();
                    reject(error);
                };
                const cleanup = () => {
                    stream.off('drain', onDrain);
                    stream.off('error', onError);
                    this._pending = null;
                };
                stream.once('drain', onDrain);
                stream.once('error', onError);
            });
        }
        return this._pending;
    }
}
