import { JSONRPCMessage, JSONRPCMessageSchema } from '../types.js';

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
        if (!this._text) {
            return null;
        }

        const index = this._text.indexOf('\n');
        if (index === -1) {
            return null;
        }

        const line = this._text.slice(0, index).replace(/\r$/, '');
        this._text = this._text.slice(index + 1);
        return deserializeMessage(line);
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
