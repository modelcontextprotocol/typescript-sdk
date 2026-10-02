import process from 'node:process';
import { Readable, Writable } from 'node:stream';
import { ReadBuffer, serializeMessage } from '../shared/stdio.js';
import { JSONRPCMessage } from '../types.js';
import { Transport } from '../shared/transport.js';

/**
 * Server transport for stdio: this communicates with an MCP client by reading from the current process' stdin and writing to stdout.
 *
 * This transport is only available in Node.js environments.
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
    _onstdinclose = () => {
        // stdin EOF means the client hung up and nothing more can arrive.
        this.close().catch(() => {});
    };

    /**
     * Starts listening for messages on stdin.
     */
    async start(): Promise<void> {
        if (this._started) {
            throw new Error(
                'StdioServerTransport already started! If using Server class, note that connect() calls start() automatically.'
            );
        }

        this._started = true;
        // A stream that already ended or was destroyed will never emit 'end'/'close' again.
        // Deferred so an onclose assigned right after connect() still sees it.
        if (this._stdin.readableEnded || this._stdin.destroyed) {
            setImmediate(this._onstdinclose);
        }
        this._stdin.on('data', this._ondata);
        this._stdin.on('error', this._onerror);
        this._stdin.on('end', this._onstdinclose);
        this._stdin.on('close', this._onstdinclose);
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
