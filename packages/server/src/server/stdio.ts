import type { Readable, Writable } from 'node:stream';

import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/core';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/core';
import { process } from '@modelcontextprotocol/server/_shims';

/**
 * Options for configuring `StdioServerTransport`.
 */
export interface StdioServerTransportOptions {
    /**
     * The readable stream to use for input. Defaults to `process.stdin`.
     */
    stdin?: Readable;

    /**
     * The writable stream to use for output. Defaults to `process.stdout`.
     */
    stdout?: Writable;

    /**
     * The PID of the client (host) process. When set, the server will periodically
     * check if the host process is still alive and self-terminate if it is gone.
     *
     * This helps prevent orphaned server processes when the host crashes or is
     * killed without cleanly shutting down the server.
     */
    clientProcessId?: number;

    /**
     * How often (in milliseconds) to check if the host process is alive.
     * Only used when `clientProcessId` is set. Defaults to 3000 (3 seconds).
     */
    watchdogIntervalMs?: number;
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
    private _clientProcessId?: number;
    private _watchdogInterval?: ReturnType<typeof setInterval>;
    private _watchdogIntervalMs: number;

    constructor(options?: StdioServerTransportOptions);
    constructor(stdin?: Readable, stdout?: Writable);
    constructor(stdinOrOptions?: Readable | StdioServerTransportOptions, stdout?: Writable) {
        if (stdinOrOptions && typeof stdinOrOptions === 'object' && !('read' in stdinOrOptions)) {
            // Options object form
            const options = stdinOrOptions as StdioServerTransportOptions;
            this._stdin = options.stdin ?? process.stdin;
            this._stdout = options.stdout ?? process.stdout;
            this._clientProcessId = options.clientProcessId;
            this._watchdogIntervalMs = options.watchdogIntervalMs ?? 3000;
        } else {
            // Legacy positional args form
            this._stdin = (stdinOrOptions as Readable) ?? process.stdin;
            this._stdout = stdout ?? process.stdout;
            this._watchdogIntervalMs = 3000;
        }
    }

    private _stdin: Readable;
    private _stdout: Writable;

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
        this._startHostWatchdog();
    }

    private _startHostWatchdog(): void {
        if (this._clientProcessId === undefined || this._watchdogInterval) {
            return;
        }

        const pid = this._clientProcessId;
        this._watchdogInterval = setInterval(() => {
            try {
                // Signal 0 does not kill the process — it just checks if it exists.
                process.kill(pid, 0);
            } catch {
                // Host process is gone, self-terminate.
                this._stopHostWatchdog();
                void this.close();
            }
        }, this._watchdogIntervalMs);

        // Ensure the watchdog timer does not prevent the process from exiting.
        if (typeof this._watchdogInterval === 'object' && 'unref' in this._watchdogInterval) {
            this._watchdogInterval.unref();
        }
    }

    private _stopHostWatchdog(): void {
        if (this._watchdogInterval) {
            clearInterval(this._watchdogInterval);
            this._watchdogInterval = undefined;
        }
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
        this._stopHostWatchdog();

        // Remove our event listeners first
        this._stdin.off('data', this._ondata);
        this._stdin.off('error', this._onerror);

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
        return new Promise(resolve => {
            const json = serializeMessage(message);
            if (this._stdout.write(json)) {
                resolve();
            } else {
                this._stdout.once('drain', resolve);
            }
        });
    }
}
