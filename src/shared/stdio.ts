import { JSONRPCMessage, JSONRPCMessageSchema } from '../types.js';

/**
 * Buffers a continuous stdio stream into discrete JSON-RPC messages.
 */
export class ReadBuffer {
    private _validLines: string[] = [];
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
        const completedLines = newLines.filter(looksLikeJson);
        this._validLines.push(...completedLines);
    }
}

/**
 *  Checks if a line looks like a JSON object.
 * @param line  The line to check.
 * @returns True if the line looks like a JSON object, false otherwise.
 */
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
