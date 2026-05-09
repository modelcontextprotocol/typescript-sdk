import type { JSONRPCMessage } from '../types/index.js';
import { JSONRPCMessageSchema } from '../types/index.js';

/**
 * Buffers a continuous stdio stream into discrete JSON-RPC messages.
 */
export class ReadBuffer {
    private _decoder = new TextDecoder('utf-8');
    private _text = '';

    append(chunk: Buffer): void {
        this._text += this._decoder.decode(chunk, { stream: true });
    }

    readMessage(): JSONRPCMessage | null {
        while (this._text) {
            const index = this._text.indexOf('\n');
            if (index === -1) {
                return null;
            }

            const line = this._text.slice(0, index).replace(/\r$/, '');
            this._text = this._text.slice(index + 1);

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
        this._decoder = new TextDecoder('utf-8');
        this._text = '';
    }
}

export function deserializeMessage(line: string): JSONRPCMessage {
    return JSONRPCMessageSchema.parse(JSON.parse(line));
}

export function serializeMessage(message: JSONRPCMessage): string {
    return JSON.stringify(message) + '\n';
}
