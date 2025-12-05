import { JSONRPCMessage, JSONRPCMessageSchema } from '../types.js';

/**
 * Buffers a continuous stdio stream into discrete JSON-RPC messages.
 */
export class ReadBuffer {
    private _buffer?: Buffer;

    append(chunk: Buffer): void {
        this._buffer = filterNonJsonLines(this._buffer ? Buffer.concat([this._buffer, chunk]) : chunk);
    }

    readMessage(): JSONRPCMessage | null {
        if (!this._buffer) {
            return null;
        }

        const index = this._buffer.indexOf('\n');
        if (index === -1) {
            return null;
        }

        const line = this._buffer.toString('utf8', 0, index).replace(/\r$/, '');
        this._buffer = this._buffer.subarray(index + 1);
        return deserializeMessage(line);
    }

    clear(): void {
        this._buffer = undefined;
    }
}

/**
 * Filters out any lines that are not valid JSON objects from the given buffer.
 * Retains the last line in case it is incomplete.
 * @param buffer The buffer to filter.
 * @returns A new buffer containing only valid JSON object lines and the last line.
 */
function filterNonJsonLines(buffer: Buffer): Buffer {
    const text = buffer.toString('utf8');
    const lines = text.split('\n');

    // Pop the last line - it may be incomplete (no trailing newline yet)
    const incompleteLine = lines.pop() ?? '';

    // Filter complete lines to only keep those that look like JSON objects
    const validLines = lines.filter(looksLikeJson);

    // Reconstruct: valid JSON lines + incomplete line
    const filteredText = validLines.length > 0 ? validLines.join('\n') + '\n' + incompleteLine : incompleteLine;

    return Buffer.from(filteredText, 'utf8');
}

function looksLikeJson(line: string): boolean {
    const trimmed = line.trim();
    return trimmed.startsWith('{') && trimmed.endsWith('}');
}

/**
 *  Deserializes a JSON-RPC message from a string.
 * @param line  The string to deserialize.
 * @returns The deserialized JSON-RPC message.
 */
export function deserializeMessage(line: string): JSONRPCMessage | null {
    return JSONRPCMessageSchema.parse(JSON.parse(line));
}

/**
 *  Serializes a JSON-RPC message to a string.
 * @param message The JSON-RPC message to serialize.
 * @returns The serialized JSON-RPC message string.
 */
export function serializeMessage(message: JSONRPCMessage): string {
    return JSON.stringify(message) + '\n';
}
