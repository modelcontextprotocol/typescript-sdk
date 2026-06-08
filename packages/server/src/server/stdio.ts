import type { Readable, Writable } from 'node:stream';

import type { JSONRPCMessage, JSONRPCMessageValidationError, RequestId, Transport } from '@modelcontextprotocol/core';
import { INVALID_REQUEST, ReadBuffer, serializeMessage } from '@modelcontextprotocol/core';
import { process } from '@modelcontextprotocol/server/_shims';

function getRequestIdFromInvalidMessage(rawMessage: unknown): RequestId | undefined {
    if (rawMessage === null || typeof rawMessage !== 'object') {
        return undefined;
    }

    const id = (rawMessage as { id?: unknown }).id;
    if (typeof id === 'string') {
        return id;
    }
    if (typeof id === 'number' && Number.isInteger(id)) {
        return id;
    }
    return undefined;
}

/**
 * Server transport for stdio: this communicates with an MCP client by reading from the current process' `stdin` and writing to `stdout`.
 *
 * This transport is only available in Node.js environments.
 *
 * @example
 * ```ts source="./stdio.examples.ts#StdioServerTransport_basicUsage"
 * const server = new McpServer({ name: 'my-server', version: '1.0.0' });
 * const transport = new StdioServerTransport();
 * await server.connect(transport);
 * ```
 */
export class StdioServerTransport implements Transport {
    private _readBuffer: ReadBuffer = new ReadBuffer();
    private _started = false;
    private _closed = false;

    constructor(
        private _stdin: Readable = process.stdin,
        private _stdout: Writable = process.stdout
    ) {}

    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    // Arrow functions to bind `this` properly, while maintaining function identity.
    _ondata = (chunk: Buffer) => {
        this._readBuffer.append(chunk);
        this.processReadBuffer();
    };
    _onerror = (error: Error) => {
        this.onerror?.(error);
    };
    _onstdouterror = (error: Error) => {
        this.onerror?.(error);
        this.close().catch(() => {
            // Ignore errors during close — we're already in an error path
        });
    };

    /**
     * Starts listening for messages on `stdin`.
     */
    async start(): Promise<void> {
        if (this._started) {
            throw new Error(
                'StdioServerTransport already started! If using Server class, note that connect() calls start() automatically.'
            );
        }

        this._started = true;
        this._stdin.on('data', this._ondata);
        this._stdin.on('error', this._onerror);
        this._stdout.on('error', this._onstdouterror);
    }

    private processReadBuffer() {
        while (true) {
            try {
                const message = this._readBuffer.readMessage();
                if (message === null) {
                    break;
                }

                this.onmessage?.(message);
            } catch (error) {
                this.onerror?.(error as Error);
                const id = getRequestIdFromInvalidMessage((error as JSONRPCMessageValidationError).rawMessage);
                if (id !== undefined) {
                    this.send({
                        jsonrpc: '2.0',
                        id,
                        error: {
                            code: INVALID_REQUEST,
                            message: 'Invalid Request'
                        }
                    }).catch(sendError => {
                        this.onerror?.(sendError);
                    });
                }
            }
        }
    }

    async close(): Promise<void> {
        if (this._closed) {
            return;
        }
        this._closed = true;

        // Remove our event listeners first
        this._stdin.off('data', this._ondata);
        this._stdin.off('error', this._onerror);
        this._stdout.off('error', this._onstdouterror);

        // Check if we were the only data listener
        const remainingDataListeners = this._stdin.listenerCount('data');
        if (remainingDataListeners === 0) {
            // Only pause stdin if we were the only listener
            // This prevents interfering with other parts of the application that might be using stdin
            this._stdin.pause();
        }

        // Clear the buffer and notify closure
        this._readBuffer.clear();
        this.onclose?.();
    }

    send(message: JSONRPCMessage): Promise<void> {
        if (this._closed) {
            return Promise.reject(new Error('StdioServerTransport is closed'));
        }
        return new Promise((resolve, reject) => {
            const json = serializeMessage(message);

            let settled = false;
            const onError = (error: Error) => {
                if (settled) return;
                settled = true;
                this._stdout.off('error', onError);
                this._stdout.off('drain', onDrain);
                reject(error);
            };
            const onDrain = () => {
                if (settled) return;
                settled = true;
                this._stdout.off('error', onError);
                this._stdout.off('drain', onDrain);
                resolve();
            };

            this._stdout.once('error', onError);

            if (this._stdout.write(json)) {
                if (settled) return;
                settled = true;
                this._stdout.off('error', onError);
                resolve();
            } else if (!settled) {
                this._stdout.once('drain', onDrain);
            }
        });
    }
}
