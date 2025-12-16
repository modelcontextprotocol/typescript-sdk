import { JSONRPCMessage, JSONRPCMessageSchema } from '../types.js';

/**
 * Buffers a continuous stdio stream into discrete JSON-RPC messages.
 */
export class ReadBuffer {
    private _validLines: object[] = [];
    private _lastIncompleteLine: string = '';

    append(chunk: Buffer): void {
        this._processChunk(chunk);
    }

    readMessage(): JSONRPCMessage | null {
        if (this._validLines.length === 0) {
            return null;
        }
        const line = this._validLines.shift()!;
        return deserializeMessage(line);
    }

    clear(): void {
        this._validLines = [];
        this._lastIncompleteLine = '';
    }

    private _processChunk(newChunk: Buffer): void {
        // Combine any previously incomplete line with the new chunk
        const combinedText = this._lastIncompleteLine + newChunk.toString('utf8');
        const newLines = combinedText.split('\n');

        // The last element may be incomplete, so store it for the next chunk
        this._lastIncompleteLine = newLines.pop() ?? '';
        const completedLines = newLines.map(safeJsonParse).filter(Boolean) as object[];
        this._validLines.push(...completedLines);
    }
}

/**
 *  Safely parses a JSON string, returning false if parsing fails.
 * @param line The JSON string to parse.
 * @returns The parsed object, or false if parsing failed.
 */
function safeJsonParse(line: string): object | false {
    try {
        return JSON.parse(line);
    } catch {
        return false;
    }
}

/**
 *  Deserializes a JSON-RPC message from object.
 * @param line  The object to deserialize.
 * @returns The deserialized JSON-RPC message.
 */
export function deserializeMessage(line: object): JSONRPCMessage | null {
    return JSONRPCMessageSchema.parse(line);
}

/**
 *  Serializes a JSON-RPC message to a string.
 * @param message The JSON-RPC message to serialize.
 * @returns The serialized JSON-RPC message string.
 */
export function serializeMessage(message: JSONRPCMessage): string {
    return JSON.stringify(message) + '\n';
}
