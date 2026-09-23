import type { JSONRPCMessage } from '../types/index';
import { JSONRPCMessageSchema } from '../types/index';

export const STDIO_DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/**
 * Buffers a continuous stdio stream into discrete JSON-RPC messages.
 */
export class ReadBuffer {
    private _buffer?: Buffer;
    private _maxBufferSize: number;
    /**
     * Set after an oversized message: its remaining bytes are still arriving
     * and are dropped, unbuffered, until the newline that ends it.
     */
    private _discardingToNewline = false;

    constructor(options?: { maxBufferSize?: number }) {
        this._maxBufferSize = options?.maxBufferSize ?? STDIO_DEFAULT_MAX_BUFFER_SIZE;
    }

    append(chunk: Buffer): void {
        if (this._discardingToNewline) {
            const newline = chunk.indexOf('\n');
            if (newline === -1) {
                return;
            }
            this._discardingToNewline = false;
            chunk = chunk.subarray(newline + 1);
        }

        const newSize = (this._buffer?.length ?? 0) + chunk.length;
        if (newSize > this._maxBufferSize) {
            this._resyncAfterOverflow(chunk);
            throw new Error(`ReadBuffer exceeded maximum size of ${this._maxBufferSize} bytes`);
        }
        if (chunk.length > 0) {
            this._buffer = this._buffer ? Buffer.concat([this._buffer, chunk]) : chunk;
        }
    }

    /**
     * Drop the message that overflowed and resume at the next message boundary.
     *
     * Clearing the buffer alone is not enough: the rest of the oversized
     * message is still in flight, and appending it into an empty buffer would
     * parse a mid-message tail as if it were the start of a new one — a second
     * error for the same message, or worse, a tail that happens to be valid
     * JSON. So the remainder is skipped up to and including its newline, and
     * anything after that newline is kept as the start of the next message.
     * If that remainder is itself over the limit it is dropped the same way.
     */
    private _resyncAfterOverflow(chunk: Buffer): void {
        this._buffer = undefined;
        const newline = chunk.indexOf('\n');
        if (newline === -1) {
            this._discardingToNewline = true;
            return;
        }
        const rest = chunk.subarray(newline + 1);
        if (rest.length > this._maxBufferSize) {
            this._resyncAfterOverflow(rest);
        } else if (rest.length > 0) {
            this._buffer = rest;
        }
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
        this._discardingToNewline = false;
    }
}

export function deserializeMessage(line: string): JSONRPCMessage {
    return JSONRPCMessageSchema.parse(JSON.parse(line));
}

export function serializeMessage(message: JSONRPCMessage): string {
    return JSON.stringify(message) + '\n';
}
