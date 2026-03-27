import type { JSONRPCMessage } from '../types/index.js';
import { JSONRPCMessageSchema } from '../types/index.js';

export class InvalidJSONRPCMessageError extends Error {
    constructor(
        message: string,
        readonly rawMessage: unknown,
        options?: ErrorOptions
    ) {
        super(message, options);
        this.name = 'InvalidJSONRPCMessageError';
    }
}

/**
 * Buffers a continuous stdio stream into discrete JSON-RPC messages.
 */
export class ReadBuffer {
    private _buffer?: Buffer;

    append(chunk: Buffer): void {
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
    const rawMessage = JSON.parse(line);
    const parseResult = JSONRPCMessageSchema.safeParse(rawMessage);

    if (parseResult.success) {
        return parseResult.data;
    }

    throw new InvalidJSONRPCMessageError('Invalid JSON-RPC message', rawMessage, {
        cause: parseResult.error
    });
}

export function serializeMessage(message: JSONRPCMessage): string {
    return JSON.stringify(message) + '\n';
}
