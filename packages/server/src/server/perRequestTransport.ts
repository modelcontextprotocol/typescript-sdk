/**
 * A single-exchange, per-request HTTP server transport for modern-era
 * (protocol revision 2026-07-28) serving.
 *
 * One transport instance serves exactly one already-classified inbound
 * JSON-RPC message and produces exactly one HTTP `Response`:
 *
 * - a `202` with no body for notifications,
 * - a single JSON body for requests whose handler produces no streamed
 *   output, or
 * - a lazily-opened SSE stream when the handler emits related messages
 *   (notifications or server-to-client requests) before its result — the
 *   stream carries those messages and finally the terminal result, then
 *   closes.
 *
 * The transport is constructed already-classified: the entry parses and
 * classifies the request body exactly once and hands the classification in via
 * the constructor; the transport attaches it (together with the original
 * request and any caller-provided auth info) to every message it delivers, and
 * the protocol layer validates it against the serving instance's negotiated
 * era. `authInfo` is strictly pass-through — it is never derived from the
 * inbound request's headers here.
 *
 * Deliberately NOT carried over from the session-oriented streamable HTTP
 * transport: session ids and session headers, resumability (event ids,
 * priming events, `Last-Event-ID` replay, retry hints), the standalone GET
 * stream, and request-header validation (which belongs to middleware). The
 * exchange is single-use; serving another request requires a new transport
 * (and, in the per-request serving model, a fresh server instance).
 */
import type {
    AuthInfo,
    JSONRPCErrorResponse,
    JSONRPCMessage,
    JSONRPCNotification,
    JSONRPCRequest,
    MessageClassification,
    MessageExtraInfo,
    RequestId,
    Transport,
    TransportSendOptions
} from '@modelcontextprotocol/core';
import {
    isJSONRPCErrorResponse,
    isJSONRPCRequest,
    isJSONRPCResultResponse,
    LADDER_ERROR_HTTP_STATUS,
    SdkError,
    SdkErrorCode
} from '@modelcontextprotocol/core';

/**
 * How the transport shapes its HTTP response for a request:
 *
 * - `auto` (default): answer with a single JSON body unless the handler emits
 *   a related message before its result, in which case the response upgrades
 *   to an SSE stream.
 * - `sse`: open the SSE stream immediately.
 * - `json`: never stream; related messages other than the terminal response
 *   are dropped.
 */
export type PerRequestResponseMode = 'auto' | 'sse' | 'json';

/** Constructor options for {@linkcode PerRequestHTTPServerTransport}. */
export interface PerRequestHTTPServerTransportOptions {
    /** The edge classification of the message this transport will serve. */
    classification: MessageClassification;
    /** Response shaping for the exchange; defaults to `auto`. */
    responseMode?: PerRequestResponseMode;
}

/** Per-exchange context handed to {@linkcode PerRequestHTTPServerTransport.handleMessage}. */
export interface PerRequestMessageExtra {
    /**
     * The original HTTP request. Used for handler context and, when the
     * runtime provides an abort signal on it, to cancel the exchange when the
     * client disconnects.
     */
    request?: globalThis.Request;
    /**
     * Validated authentication information supplied by the caller. Strictly
     * pass-through: the transport never populates this from request headers.
     */
    authInfo?: AuthInfo;
}

interface DeferredResponse {
    promise: Promise<Response>;
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
    settled: boolean;
}

interface SseSink {
    controller: ReadableStreamDefaultController<Uint8Array>;
    encoder: InstanceType<typeof TextEncoder>;
    closed: boolean;
}

/**
 * The per-request micro-transport: a real, connected `Transport` whose whole
 * lifetime is one HTTP exchange. See the module documentation for the
 * response shapes it produces.
 */
export class PerRequestHTTPServerTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

    private readonly _classification: MessageClassification;
    private readonly _responseMode: PerRequestResponseMode;

    private _started = false;
    private _used = false;
    private _closed = false;
    private _terminalDelivered = false;
    private _requestId?: RequestId;
    private _deferredResponse?: DeferredResponse;
    private _sse?: SseSink;
    private _abortCleanup?: () => void;

    constructor(options: PerRequestHTTPServerTransportOptions) {
        this._classification = options.classification;
        this._responseMode = options.responseMode ?? 'auto';
    }

    async start(): Promise<void> {
        if (this._started) {
            throw new Error('PerRequestHTTPServerTransport is already started');
        }
        this._started = true;
    }

    /**
     * Serves the single exchange: delivers the classified message to the
     * connected server instance and resolves with the HTTP response.
     *
     * Throws when called a second time (the transport is strictly
     * single-use), or before a server has been connected to the transport.
     * The returned promise rejects with a connection-closed error when the
     * transport is closed before a response was produced (for example because
     * the client disconnected).
     */
    async handleMessage(message: JSONRPCRequest | JSONRPCNotification, extra?: PerRequestMessageExtra): Promise<Response> {
        if (this._used) {
            throw new Error('PerRequestHTTPServerTransport serves exactly one exchange; construct a new transport per request');
        }
        this._used = true;
        if (!this._started || this.onmessage === undefined) {
            throw new Error('PerRequestHTTPServerTransport is not connected: connect a server to this transport before handling a message');
        }
        if (this._closed) {
            throw new Error('PerRequestHTTPServerTransport is closed');
        }

        const signal = extra?.request?.signal;
        if (signal?.aborted) {
            await this.close();
            throw new SdkError(SdkErrorCode.ConnectionClosed, 'The request was aborted before it could be handled');
        }

        // authInfo is strictly pass-through from the caller; it is never
        // derived from the inbound request's headers.
        const messageExtra: MessageExtraInfo = {
            classification: this._classification,
            ...(extra?.request !== undefined && { request: extra.request }),
            ...(extra?.authInfo !== undefined && { authInfo: extra.authInfo })
        };

        if (isJSONRPCRequest(message)) {
            this._requestId = message.id;

            let resolve!: (response: Response) => void;
            let reject!: (error: Error) => void;
            const promise = new Promise<Response>((promiseResolve, promiseReject) => {
                resolve = promiseResolve;
                reject = promiseReject;
            });
            this._deferredResponse = { promise, resolve, reject, settled: false };

            if (signal !== undefined) {
                const onAbort = () => void this.close();
                signal.addEventListener('abort', onAbort, { once: true });
                this._abortCleanup = () => signal.removeEventListener('abort', onAbort);
            }

            if (this._responseMode === 'sse') {
                this.upgradeToSse();
            }

            this.onmessage(message, messageExtra);
            return promise;
        }

        // Notifications never get a JSON-RPC response: deliver the message and
        // acknowledge the POST with 202 and no body.
        this.onmessage(message, messageExtra);
        return new Response(null, { status: 202 });
    }

    async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
        if (this._closed) {
            // The exchange is over; late writes are dropped.
            return;
        }

        const isResponse = isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message);
        const relatedId = isResponse ? (message as { id: RequestId }).id : options?.relatedRequestId;

        if (this._requestId === undefined || relatedId === undefined || relatedId !== this._requestId) {
            if (isResponse) {
                this.onerror?.(new Error(`Received a response for an unknown request id: ${String((message as { id?: unknown }).id)}`));
            }
            // Messages unrelated to the single in-flight request have nowhere
            // to go on a per-request exchange (there is no session-wide
            // stream); they are dropped.
            return;
        }

        if (isResponse) {
            if (this._terminalDelivered) {
                return;
            }
            this._terminalDelivered = true;

            if (this._sse !== undefined) {
                // Finalize the stream: serialize the terminal result onto it
                // after everything already enqueued, then close.
                this.writeMessageFrame(message);
                this.finalizeStream();
                return;
            }

            // Single JSON body. Errors produced before a handler ran (the
            // protocol-version mismatch, the era registry gate, a missing
            // handler) carry the codes in the ladder status table and are
            // answered with the mapped HTTP status; every other error —
            // whatever its code — stays in-band on HTTP 200.
            const status = isJSONRPCErrorResponse(message)
                ? (LADDER_ERROR_HTTP_STATUS[(message as JSONRPCErrorResponse).error.code] ?? 200)
                : 200;
            this.settleResponse(Response.json(message, { status, headers: { 'Content-Type': 'application/json' } }));
            queueMicrotask(() => void this.close());
            return;
        }

        // A message related to the in-flight request that is not its terminal
        // response: a mid-call notification or a server-to-client request
        // emitted by the handler.
        if (this._responseMode === 'json') {
            // JSON responses cannot carry mid-call messages; they are dropped.
            return;
        }
        if (this._sse === undefined) {
            this.upgradeToSse();
        }
        this.writeMessageFrame(message);
    }

    /**
     * Writes an SSE comment frame (a keep-alive heartbeat). Dropped when the
     * exchange is not currently streaming.
     */
    writeCommentFrame(comment: string): void {
        if (this._closed || this._sse === undefined || this._sse.closed) {
            return;
        }
        const frame = comment
            .split('\n')
            .map(line => `: ${line}`)
            .join('\n');
        this.writeFrame(`${frame}\n\n`);
    }

    async close(): Promise<void> {
        if (this._closed) {
            return;
        }
        this._closed = true;

        this._abortCleanup?.();
        this._abortCleanup = undefined;

        if (this._sse !== undefined && !this._sse.closed) {
            this._sse.closed = true;
            try {
                this._sse.controller.close();
            } catch {
                // The stream was already closed or cancelled by the consumer.
            }
        }

        if (this._deferredResponse !== undefined && !this._deferredResponse.settled) {
            this._deferredResponse.settled = true;
            this._deferredResponse.reject(new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed before a response was produced'));
        }

        this.onclose?.();
    }

    private settleResponse(response: Response): void {
        if (this._deferredResponse === undefined || this._deferredResponse.settled) {
            return;
        }
        this._deferredResponse.settled = true;
        this._deferredResponse.resolve(response);
    }

    private upgradeToSse(): void {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const readable = new ReadableStream<Uint8Array>({
            start: streamController => {
                controller = streamController;
            },
            cancel: () => {
                // The client went away mid-stream: tear the exchange down,
                // which aborts the in-flight handler through the connected
                // server's close chain.
                void this.close();
            }
        });
        this._sse = { controller, encoder: new TextEncoder(), closed: false };

        this.settleResponse(
            new Response(readable, {
                status: 200,
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive',
                    // Disable proxy buffering so streamed messages are
                    // delivered as they are written.
                    'X-Accel-Buffering': 'no'
                }
            })
        );
    }

    private finalizeStream(): void {
        if (this._sse !== undefined && !this._sse.closed) {
            this._sse.closed = true;
            try {
                this._sse.controller.close();
            } catch {
                // The stream was already cancelled by the consumer.
            }
        }
        queueMicrotask(() => void this.close());
    }

    private writeMessageFrame(message: JSONRPCMessage): void {
        this.writeFrame(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    }

    private writeFrame(frame: string): void {
        if (this._sse === undefined || this._sse.closed) {
            return;
        }
        try {
            this._sse.controller.enqueue(this._sse.encoder.encode(frame));
        } catch (error) {
            this.onerror?.(new Error(`Failed to write to the response stream: ${error}`));
        }
    }
}
