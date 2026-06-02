import { SdkError, SdkErrorCode } from '../errors/sdkErrors.js';
import type { JSONRPCMessage } from '../types/index.js';
import { JSONRPCMessageSchema } from '../types/index.js';

/**
 * Options for {@linkcode ReadBuffer}.
 */
export interface ReadBufferOptions {
    /**
     * Maximum size, in bytes, that a single newline-delimited message may occupy.
     *
     * When set, a message larger than this limit — whether or not its terminating
     * newline has arrived yet — is dropped and an {@linkcode SdkError} with code
     * {@linkcode SdkErrorCode.MessageTooLarge} is thrown from
     * {@linkcode ReadBuffer.readMessage}. The stdio transports surface that error
     * through their `onerror` callback and keep running: buffered data belonging to
     * the oversized message is discarded until the next newline boundary, after
     * which subsequent messages are processed normally.
     *
     * When undefined (the default), no limit is enforced.
     */
    maxMessageBytes?: number;
}

const INITIAL_CAPACITY = 8192;

/**
 * Capacity above which the internal buffer is shrunk back to {@linkcode INITIAL_CAPACITY}
 * once it is fully drained, so that one large message does not pin memory forever.
 */
const SHRINK_CAPACITY_THRESHOLD = 131_072;

const NEWLINE = 0x0a;

/**
 * Buffers a continuous stdio stream into discrete JSON-RPC messages.
 *
 * Internally maintains a single growable buffer with read/scan offsets so that
 * appending a chunk and scanning for message boundaries are amortized O(1) per
 * byte, independent of how many chunks an incomplete message spans.
 */
export class ReadBuffer {
    private _buffer: Buffer = Buffer.alloc(INITIAL_CAPACITY);
    /** Offset of the first unconsumed byte. */
    private _start = 0;
    /** Offset past the last valid byte. */
    private _end = 0;
    /** Offset up to which the buffer has already been scanned for a newline. */
    private _scanned = 0;
    /** When true, data is dropped until the next newline boundary (oversized-message recovery). */
    private _discarding = false;
    private readonly _maxMessageBytes?: number;

    constructor(options?: ReadBufferOptions) {
        this._maxMessageBytes = options?.maxMessageBytes;
    }

    append(chunk: Buffer): void {
        this._ensureCapacity(chunk.length);
        chunk.copy(this._buffer, this._end);
        this._end += chunk.length;
    }

    readMessage(): JSONRPCMessage | null {
        while (true) {
            const newlineIndex = this._findNewline();
            if (newlineIndex === -1) {
                if (this._discarding) {
                    // Still inside an oversized message: drop everything buffered so far.
                    this._reset();
                    return null;
                }

                const pending = this._end - this._start;
                if (this._maxMessageBytes !== undefined && pending > this._maxMessageBytes) {
                    this._discarding = true;
                    this._reset();
                    throw new SdkError(
                        SdkErrorCode.MessageTooLarge,
                        `Message exceeds maxMessageBytes (${this._maxMessageBytes}): received ${pending} bytes without a message boundary. ` +
                            `Discarding data until the next newline.`
                    );
                }

                return null;
            }

            const lineStart = this._start;
            const lineLength = newlineIndex - lineStart;

            if (this._discarding) {
                // The tail of an oversized message: drop it and resume normal processing.
                this._consume(newlineIndex);
                this._discarding = false;
                continue;
            }

            if (this._maxMessageBytes !== undefined && lineLength > this._maxMessageBytes) {
                this._consume(newlineIndex);
                throw new SdkError(
                    SdkErrorCode.MessageTooLarge,
                    `Message exceeds maxMessageBytes (${this._maxMessageBytes}): a ${lineLength}-byte message was received and dropped.`
                );
            }

            const line = this._buffer.toString('utf8', lineStart, newlineIndex).replace(/\r$/, '');
            this._consume(newlineIndex);

            try {
                return deserializeMessage(line);
            } catch (error) {
                // Skip non-JSON lines (e.g. debug output from hot-reload tools like
                // tsx or nodemon that write to stdout). Schema validation errors still
                // throw so malformed-but-valid-JSON messages surface via onerror.
                if (error instanceof SyntaxError) {
                    continue;
                }
                throw error;
            }
        }
    }

    clear(): void {
        this._discarding = false;
        this._reset();
    }

    /** Returns the index of the next newline, scanning only bytes not seen before. */
    private _findNewline(): number {
        if (this._scanned >= this._end) {
            return -1;
        }

        const index = this._buffer.subarray(this._scanned, this._end).indexOf(NEWLINE);
        if (index === -1) {
            this._scanned = this._end;
            return -1;
        }

        return this._scanned + index;
    }

    /** Consumes all bytes up to and including the newline at `newlineIndex`. */
    private _consume(newlineIndex: number): void {
        this._start = newlineIndex + 1;
        this._scanned = this._start;
        if (this._start === this._end) {
            this._reset();
        }
    }

    /** Drops all buffered data, shrinking the buffer if a large message inflated it. */
    private _reset(): void {
        this._start = 0;
        this._end = 0;
        this._scanned = 0;
        if (this._buffer.length > SHRINK_CAPACITY_THRESHOLD) {
            this._buffer = Buffer.alloc(INITIAL_CAPACITY);
        }
    }

    /** Makes room for `extra` more bytes, compacting in place or growing geometrically. */
    private _ensureCapacity(extra: number): void {
        if (this._end + extra <= this._buffer.length) {
            return;
        }

        const used = this._end - this._start;
        if (used + extra <= this._buffer.length) {
            // Enough total room: reclaim the consumed prefix in place.
            this._buffer.copyWithin(0, this._start, this._end);
        } else {
            let capacity = this._buffer.length * 2;
            while (capacity < used + extra) {
                capacity *= 2;
            }

            const next = Buffer.alloc(capacity);
            this._buffer.copy(next, 0, this._start, this._end);
            this._buffer = next;
        }

        this._end = used;
        this._scanned -= this._start;
        this._start = 0;
    }
}

export function deserializeMessage(line: string): JSONRPCMessage {
    return JSONRPCMessageSchema.parse(JSON.parse(line));
}

export function serializeMessage(message: JSONRPCMessage): string {
    return JSON.stringify(message) + '\n';
}
