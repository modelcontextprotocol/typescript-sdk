import type { Readable, Writable } from 'node:stream';

import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/core-internal';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/core-internal';
import { process } from '@modelcontextprotocol/server/_shims';

/**
 * Marks a stdout `'error'` listener that a closed transport left attached purely to
 * swallow late write failures (see {@link StdioServerTransport.close}). A fresh
 * transport taking over the same stream removes listeners carrying this tag in
 * `start()`, so repeated create→close cycles on the process-global `process.stdout`
 * don't accumulate listeners.
 */
const swallowsErrorsAfterClose = Symbol('swallowsErrorsAfterClose');

/**
 * Server transport for stdio: this communicates with an MCP client by reading from the current process' `stdin` and writing to `stdout`.
 *
 * This transport is only available in Node.js environments.
 *
 * When the client closes its end of the pipe (stdin reaches end-of-file), the transport
 * closes itself and fires `onclose`, per the MCP stdio binding's guidance that servers
 * should exit promptly when their standard input is closed. A server that holds no other
 * keep-alive handles will then exit naturally.
 *
 * @example
 * ```ts source="./stdio.examples.ts#StdioServerTransport_basicUsage"
 * const server = new McpServer({ name: 'my-server', version: '1.0.0' });
 * const transport = new StdioServerTransport();
 * await server.connect(transport);
 * ```
 */
export class StdioServerTransport implements Transport {
    private _readBuffer: ReadBuffer;
    private _started = false;
    private _closed = false;

    constructor(
        private _stdin: Readable = process.stdin,
        private _stdout: Writable = process.stdout,
        options?: {
            /**
             * Maximum size of the read buffer in bytes. If a single message exceeds
             * this size the transport will emit an error and close.
             *
             * Defaults to 10 MB.
             */
            maxBufferSize?: number;
        }
    ) {
        this._readBuffer = new ReadBuffer({ maxBufferSize: options?.maxBufferSize });
    }

    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    // Arrow functions to bind `this` properly, while maintaining function identity.
    _ondata = (chunk: Buffer) => {
        try {
            this._readBuffer.append(chunk);
            this.processReadBuffer();
        } catch (error) {
            this.onerror?.(error as Error);
            this.close().catch(() => {});
        }
    };
    _onerror = (error: Error) => {
        this.onerror?.(error);
    };
    _onstdouterror = (error: Error) => {
        if (this._closed) {
            // Swallow stdout errors that surface after close. A write accepted before
            // close (`write()` returned true) can still fail asynchronously at the OS
            // level — e.g. EPIPE when the client that hung up also stops reading our
            // stdout. The transport is already closed, so there is nothing to do; but
            // with no listener attached, that late 'error' event would crash the
            // process with an uncaught exception — which is why close() leaves this
            // listener attached.
            return;
        }
        this.onerror?.(error);
        this.close().catch(() => {
            // Ignore errors during close — we're already in an error path
        });
    };
    _onstdinclose = () => {
        // stdin reaching EOF (or being destroyed) means the client has hung up and no
        // further input can ever arrive. The MCP stdio binding says servers should exit
        // promptly when their standard input closes — this is the primary graceful
        // shutdown signal, and on some platforms (e.g. Windows) the only reliable one.
        // Close the transport so `onclose` fires and the process can exit naturally.
        this.close().catch(() => {
            // Ignore errors during close — nothing more can be read anyway
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
        // Remove swallow-only 'error' listeners left behind by previously closed
        // transports on this stream (see close()). Our own listener covers the
        // stream from here on, so the stale ones are no longer needed — without
        // this sweep, repeated create→close cycles on the process-global
        // process.stdout would accumulate listeners.
        for (const listener of this._stdout.listeners('error')) {
            if ((listener as { [swallowsErrorsAfterClose]?: boolean })[swallowsErrorsAfterClose]) {
                this._stdout.off('error', listener as (error: Error) => void);
            }
        }
        // A stream that already ended or was destroyed before start() ran has
        // emitted its one 'end'/'close' event; the listeners below would never
        // fire. This can happen with a custom stream (e.g. a net.Socket the
        // peer reset during async setup) — treat it as the client having hung
        // up, deferred by a microtask so onclose isn't invoked before start()
        // returns.
        if (this._stdin.readableEnded || this._stdin.destroyed) {
            queueMicrotask(this._onstdinclose);
        }
        this._stdin.on('data', this._ondata);
        this._stdin.on('error', this._onerror);
        this._stdin.on('end', this._onstdinclose);
        this._stdin.on('close', this._onstdinclose);
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
        this._stdin.off('end', this._onstdinclose);
        this._stdin.off('close', this._onstdinclose);
        // Deliberately keep _onstdouterror attached (it is a no-op now that _closed
        // is set): a write that was accepted before close may still be pending at
        // the OS level and can fail after close (e.g. EPIPE when the client hangs
        // up), and an 'error' event on a listener-less stream would crash the
        // process. Tag it so the next transport to start on this stream can sweep
        // it away instead of letting closed transports' listeners accumulate.
        (this._onstdouterror as { [swallowsErrorsAfterClose]?: boolean })[swallowsErrorsAfterClose] = true;

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
