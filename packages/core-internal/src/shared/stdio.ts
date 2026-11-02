import type { JSONRPCMessage } from '../types/index';
import { JSONRPCMessageSchema } from '../types/index';

export const STDIO_DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/**
 * Buffers a continuous stdio stream into discrete JSON-RPC messages.
 */
export class ReadBuffer {
    private _chunks: Buffer[] = [];
    private _totalLength = 0;
    private _newlineChunkIndex = -1;
    private _newlineOffsetInChunk = -1;
    private _maxBufferSize: number;

    constructor(options?: { maxBufferSize?: number }) {
        this._maxBufferSize = options?.maxBufferSize ?? STDIO_DEFAULT_MAX_BUFFER_SIZE;
    }

    append(chunk: Buffer): void {
        if (chunk.length === 0) {
            return;
        }

        const newSize = this._totalLength + chunk.length;
        if (newSize > this._maxBufferSize) {
            this.clear();
            throw new Error(`ReadBuffer exceeded maximum size of ${this._maxBufferSize} bytes`);
        }

        if (this._newlineChunkIndex === -1) {
            const index = chunk.indexOf(0x0a);
            if (index !== -1) {
                this._newlineChunkIndex = this._chunks.length;
                this._newlineOffsetInChunk = index;
            }
        }

        this._chunks.push(chunk);
        this._totalLength = newSize;
    }

    readMessage(): JSONRPCMessage | null {
        while (this._newlineChunkIndex !== -1) {
            const targetChunkIndex = this._newlineChunkIndex;
            const newlineOffset = this._newlineOffsetInChunk;
            const targetChunk = this._chunks[targetChunkIndex];

            if (!targetChunk) {
                this.clear();
                return null;
            }

            const messageParts: Buffer[] = [];
            let consumedBytes = newlineOffset + 1;
            for (let i = 0; i < targetChunkIndex; i++) {
                const chunk = this._chunks[i];
                if (chunk) {
                    messageParts.push(chunk);
                    consumedBytes += chunk.length;
                }
            }
            if (newlineOffset > 0) {
                messageParts.push(targetChunk.subarray(0, newlineOffset));
            }

            const messageBuffer =
                messageParts.length === 1
                    ? (messageParts[0] ?? Buffer.alloc(0))
                    : messageParts.length === 0
                      ? Buffer.alloc(0)
                      : Buffer.concat(messageParts);

            const remainder = targetChunk.subarray(newlineOffset + 1);
            const remainingChunks: Buffer[] = [];
            if (remainder.length > 0) {
                remainingChunks.push(remainder);
            }
            for (let i = targetChunkIndex + 1; i < this._chunks.length; i++) {
                const chunk = this._chunks[i];
                if (chunk) {
                    remainingChunks.push(chunk);
                }
            }

            this._chunks = remainingChunks;
            this._totalLength -= consumedBytes;

            this._newlineChunkIndex = -1;
            this._newlineOffsetInChunk = -1;
            for (let i = 0; i < this._chunks.length; i++) {
                const chunk = this._chunks[i];
                if (chunk) {
                    const index = chunk.indexOf(0x0a);
                    if (index !== -1) {
                        this._newlineChunkIndex = i;
                        this._newlineOffsetInChunk = index;
                        break;
                    }
                }
            }

            const line = messageBuffer.toString('utf8').replace(/\r$/, '');

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
        this._chunks = [];
        this._totalLength = 0;
        this._newlineChunkIndex = -1;
        this._newlineOffsetInChunk = -1;
    }
}

export function deserializeMessage(line: string): JSONRPCMessage {
    return JSONRPCMessageSchema.parse(JSON.parse(line));
}

export function serializeMessage(message: JSONRPCMessage): string {
    return JSON.stringify(message) + '\n';
}
