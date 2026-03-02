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
        // Handle stdout errors (e.g., EPIPE when client disconnects)
        // Trigger close to clean up gracefully
        this.close().catch(() => {
            // Ignore errors during close
        });
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

            // Handle write errors (e.g., EPIPE when client disconnects)
            const onError = (error: Error) => {
                this._stdout.off('error', onError);
                reject(error);
            };

            this._stdout.once('error', onError);

            if (this._stdout.write(json)) {
                this._stdout.off('error', onError);
                resolve();
            } else {
                this._stdout.once('drain', () => {
                    this._stdout.off('error', onError);
                    resolve();
                });
            }
        });
    }
}
