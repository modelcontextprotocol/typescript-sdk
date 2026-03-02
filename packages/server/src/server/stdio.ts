import type { Readable, Writable } from 'node:stream';

import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/core';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/core';
import { process } from '@modelcontextprotocol/server/_shims';

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
        // Handle stdout broken pipe when client disconnects.
        if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
            this.close().catch(() => {
                // Ignore errors during close
            });
            return;
        }

        this.onerror?.(error);
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
        return new Promise((resolve, reject) => {
            const json = serializeMessage(message);
            let settled = false;

            const cleanup = () => {
                this._stdout.off('error', onError);
                this._stdout.off('drain', onDrain);
            };

            const onDrain = () => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                resolve();
            };

            const onError = (error: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();

                if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
                    this.close().catch(() => {
                        // Ignore errors during close
                    });
                    resolve();
                    return;
                }

                reject(error);
            };

            this._stdout.once('error', onError);

            try {
                if (this._stdout.write(json)) {
                    settled = true;
                    cleanup();
                    resolve();
                } else {
                    this._stdout.once('drain', onDrain);
                }
            } catch (error) {
                onError(error as Error);
            }
        });
    }
}
