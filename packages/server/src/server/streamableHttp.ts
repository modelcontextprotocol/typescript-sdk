/**
 * Web Standards Streamable HTTP Server Transport
 *
 * Thin compat wrapper over {@linkcode shttpHandler} + {@linkcode SessionCompat} +
 * {@linkcode BackchannelCompat}. The class name, constructor options, and
 * {@linkcode Transport} interface are kept for back-compat so existing
 * `server.connect(new WebStandardStreamableHTTPServerTransport({...}))` code
 * works unchanged. Request handling delegates to {@linkcode shttpHandler}.
 *
 * For Node.js Express/HTTP compatibility, use
 * {@linkcode @modelcontextprotocol/node!NodeStreamableHTTPServerTransport | NodeStreamableHTTPServerTransport}
 * which wraps this transport.
 */

import type {
    AuthInfo,
    JSONRPCErrorResponse,
    JSONRPCMessage,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResultResponse,
    MessageExtraInfo,
    RequestEnv,
    RequestTransport,
    TransportSendOptions
} from '@modelcontextprotocol/core';
import { isJSONRPCErrorResponse, isJSONRPCResultResponse, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/core';

import { BackchannelCompat } from './backchannelCompat.js';
import { SessionCompat } from './sessionCompat.js';
import type { ShttpRequestExtra } from './shttpHandler.js';
import { shttpHandler, STATELESS_GET_KEY } from './shttpHandler.js';

export type { EventId, EventStore, StreamId } from './shttpHandler.js';

/**
 * Configuration options for {@linkcode WebStandardStreamableHTTPServerTransport}
 */
export interface WebStandardStreamableHTTPServerTransportOptions {
    /**
     * Function that generates a session ID for the transport.
     * The session ID SHOULD be globally unique and cryptographically secure (e.g., a securely generated UUID, a JWT, or a cryptographic hash)
     *
     * If not provided, session management is disabled (stateless mode).
     */
    sessionIdGenerator?: () => string;

    /**
     * A callback for session initialization events
     * This is called when the server initializes a new session.
     * Useful in cases when you need to register multiple mcp sessions
     * and need to keep track of them.
     * @param sessionId The generated session ID
     */
    onsessioninitialized?: (sessionId: string) => void | Promise<void>;

    /**
     * A callback for session close events
     * This is called when the server closes a session due to a `DELETE` request.
     * Useful in cases when you need to clean up resources associated with the session.
     * Note that this is different from the transport closing, if you are handling
     * HTTP requests from multiple nodes you might want to close each
     * {@linkcode WebStandardStreamableHTTPServerTransport} after a request is completed while still keeping the
     * session open/running.
     * @param sessionId The session ID that was closed
     */
    onsessionclosed?: (sessionId: string) => void | Promise<void>;

    /**
     * If `true`, the server will return JSON responses instead of starting an SSE stream.
     * This can be useful for simple request/response scenarios without streaming.
     * Default is `false` (SSE streams are preferred).
     */
    enableJsonResponse?: boolean;

    /**
     * Event store for resumability support
     * If provided, resumability will be enabled, allowing clients to reconnect and resume messages
     */
    eventStore?: import('./shttpHandler.js').EventStore;

    /**
     * List of allowed `Host` header values for DNS rebinding protection.
     * If not specified, host validation is disabled.
     * @deprecated Use external middleware for host validation instead.
     */
    allowedHosts?: string[];

    /**
     * List of allowed `Origin` header values for DNS rebinding protection.
     * If not specified, origin validation is disabled.
     * @deprecated Use external middleware for origin validation instead.
     */
    allowedOrigins?: string[];

    /**
     * Enable DNS rebinding protection (requires `allowedHosts` and/or `allowedOrigins` to be configured).
     * Default is `false` for backwards compatibility.
     * @deprecated Use external middleware for DNS rebinding protection instead.
     */
    enableDnsRebindingProtection?: boolean;

    /**
     * Retry interval in milliseconds to suggest to clients in SSE `retry` field.
     * When set, the server will send a `retry` field in SSE priming events to control
     * client reconnection timing for polling behavior.
     */
    retryInterval?: number;

    /**
     * List of protocol versions that this transport will accept.
     * Used to validate the `mcp-protocol-version` header in incoming requests.
     *
     * Note: When using {@linkcode server/server.Server.connect | Server.connect()}, the server automatically passes its
     * `supportedProtocolVersions` to the transport, so you typically don't need
     * to set this option directly.
     *
     * @default {@linkcode SUPPORTED_PROTOCOL_VERSIONS}
     */
    supportedProtocolVersions?: string[];
}

/**
 * Options for handling a request
 */
export interface HandleRequestOptions {
    /**
     * Pre-parsed request body. If provided, the transport will use this instead of parsing `req.json()`.
     * Useful when using body-parser middleware that has already parsed the body.
     */
    parsedBody?: unknown;

    /**
     * Authentication info from middleware. If provided, will be passed to message handlers.
     */
    authInfo?: AuthInfo;
}

/**
 * Server transport for Web Standards Streamable HTTP: this implements the MCP Streamable HTTP transport specification
 * using Web Standard APIs (`Request`, `Response`, `ReadableStream`).
 *
 * This transport works on any runtime that supports Web Standards: Node.js 18+, Cloudflare Workers, Deno, Bun, etc.
 *
 * In stateful mode:
 * - Session ID is generated and included in response headers
 * - Session ID is always included in initialization responses
 * - Requests with invalid session IDs are rejected with `404 Not Found`
 * - GET opens a standalone subscription stream; DELETE terminates the session
 *
 * In stateless mode (no `sessionIdGenerator`):
 * - No session validation; GET/DELETE return 405
 *
 * The class is now a thin shim: {@linkcode handleRequest} delegates to a captured
 * {@linkcode shttpHandler} bound at {@linkcode connect | connect()} time. The
 * {@linkcode Transport} interface methods route outbound messages through the
 * per-session {@linkcode BackchannelCompat}.
 */
export class WebStandardStreamableHTTPServerTransport implements RequestTransport {
    readonly kind = 'request' as const;

    private _options: WebStandardStreamableHTTPServerTransportOptions;
    private _session?: SessionCompat;
    private _backchannel = new BackchannelCompat();
    private _handler: (req: Request, extra?: ShttpRequestExtra) => Promise<Response>;
    private _started = false;
    private _closed = false;
    private _supportedProtocolVersions: string[];

    sessionId?: string;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

    /** {@linkcode RequestTransport.onrequest} — set by `McpServer.connect()`. */
    onrequest: ((req: JSONRPCRequest, env?: RequestEnv) => AsyncIterable<JSONRPCMessage>) | undefined = undefined;
    /** {@linkcode RequestTransport.onnotification} — set by `McpServer.connect()`. */
    onnotification?: (n: JSONRPCNotification) => void | Promise<void>;
    /** {@linkcode RequestTransport.onresponse} — set by `McpServer.connect()`. */
    onresponse?: (r: JSONRPCResultResponse | JSONRPCErrorResponse) => boolean;

    constructor(options: WebStandardStreamableHTTPServerTransportOptions = {}) {
        this._options = options;
        this._supportedProtocolVersions = options.supportedProtocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS;
        if (options.sessionIdGenerator) {
            this._session = new SessionCompat({
                sessionIdGenerator: options.sessionIdGenerator,
                singleSession: true,
                onerror: e => this.onerror?.(e),
                onsessioninitialized: id => {
                    this.sessionId = id;
                    return options.onsessioninitialized?.(id);
                },
                onsessionclosed: id => {
                    this._backchannel.closeSession(id);
                    return options.onsessionclosed?.(id);
                }
            });
        }
        // shttpHandler reads onrequest/onnotification/onresponse from `this` at call time,
        // so connect() can set them after construction.
        this._handler = shttpHandler(this, {
            session: this._session,
            backchannel: this._backchannel,
            eventStore: this._options.eventStore,
            enableJsonResponse: this._options.enableJsonResponse,
            retryInterval: this._options.retryInterval,
            supportedProtocolVersions: this._supportedProtocolVersions,
            onerror: e => this.onerror?.(e)
        });
    }

    /**
     * Handles an incoming Web-standard {@linkcode Request} and returns a Web-standard {@linkcode Response}.
     */
    async handleRequest(req: Request, options: HandleRequestOptions = {}): Promise<Response> {
        if (this._options.enableDnsRebindingProtection) {
            const err = this._validateDnsRebinding(req);
            if (err) return err;
        }
        return this._handler(req, { parsedBody: options.parsedBody, authInfo: options.authInfo });
    }

    /**
     * Starts the transport. This is required by the {@linkcode Transport} interface but is a no-op
     * for the Streamable HTTP transport as connections are managed per-request.
     */
    async start(): Promise<void> {
        if (this._started) {
            throw new Error('Transport already started');
        }
        this._started = true;
    }

    /**
     * Sets the supported protocol versions for header validation.
     * Called by the server during {@linkcode server/server.Server.connect | connect()} to pass its supported versions.
     */
    setSupportedProtocolVersions(versions: string[]): void {
        this._supportedProtocolVersions = versions;
    }

    setProtocolVersion(_version: string): void {
        // No-op: protocol version is per-session in SessionCompat.
    }

    /**
     * {@linkcode RequestTransport.notify} — write an unsolicited notification to the
     * session's standalone GET subscription stream (2025-11 back-compat).
     */
    async notify(n: JSONRPCNotification): Promise<void> {
        if (this._closed) return;
        const sessionId = this.sessionId ?? STATELESS_GET_KEY;
        const written = this._backchannel.writeStandalone(sessionId, n);
        if (!written && this._options.eventStore) {
            await this._options.eventStore.storeEvent('_GET_stream', n);
        }
    }

    /**
     * {@linkcode RequestTransport.request} — send an unsolicited server→client request via
     * the standalone GET stream and await the client's POSTed-back response (2025-11 back-compat).
     */
    request(r: JSONRPCRequest): Promise<JSONRPCResultResponse | JSONRPCErrorResponse> {
        const sessionId = this.sessionId ?? STATELESS_GET_KEY;
        const send = this._backchannel.makeEnvSend(sessionId, msg => void this._backchannel.writeStandalone(sessionId, msg));
        return send({ method: r.method, params: r.params }, {}).then(
            result => ({ jsonrpc: '2.0', id: r.id, result }) as JSONRPCResultResponse,
            (error: { code?: number; message?: string; data?: unknown }) => ({
                jsonrpc: '2.0',
                id: r.id,
                error: {
                    code: error.code ?? -32_603,
                    message: error.message ?? String(error),
                    ...(error.data !== undefined && { data: error.data })
                }
            })
        );
    }

    /**
     * {@linkcode ChannelTransport.send} (back-compat costume). Outbound responses route to the
     * {@linkcode BackchannelCompat} resolver map; notifications and server-initiated requests go
     * on the session's standalone GET stream.
     *
     * @deprecated Use {@linkcode notify} / {@linkcode request} (the {@linkcode RequestTransport} surface).
     */
    async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
        if (this._closed) return;
        const sessionId = this.sessionId ?? STATELESS_GET_KEY;
        if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
            this._backchannel.handleResponse(sessionId, message);
            return;
        }
        const written = this._backchannel.writeStandalone(sessionId, message);
        if (!written && this._options.eventStore) {
            await this._options.eventStore.storeEvent('_GET_stream', message);
        }
    }

    /**
     * Close an SSE stream for a specific request, triggering client reconnection.
     * @deprecated Per-request stream tracking was removed; this is now a no-op. Use
     * `ctx.http?.closeSSE` from inside the handler instead.
     */
    closeSSEStream(_requestId: unknown): void {
        // No per-request stream map in the new model.
    }

    /**
     * Close the standalone GET SSE stream, triggering client reconnection.
     */
    closeStandaloneSSEStream(): void {
        if (this.sessionId !== undefined) {
            this._session?.closeStandaloneStream(this.sessionId);
            this._backchannel.setStandaloneWriter(this.sessionId, undefined);
        }
    }

    /**
     * Closes the transport.
     */
    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        if (this.sessionId !== undefined) {
            this._backchannel.closeSession(this.sessionId);
            await this._session?.delete(this.sessionId);
        }
        this.onclose?.();
    }

    private _validateDnsRebinding(req: Request): Response | undefined {
        if (this._options.allowedHosts && this._options.allowedHosts.length > 0) {
            const host = req.headers.get('host');
            if (!host || !this._options.allowedHosts.includes(host)) {
                return Response.json(
                    { jsonrpc: '2.0', error: { code: -32_000, message: `Invalid Host header: ${host ?? '(missing)'}` }, id: null },
                    { status: 403 }
                );
            }
        }
        if (this._options.allowedOrigins && this._options.allowedOrigins.length > 0) {
            const origin = req.headers.get('origin');
            if (origin && !this._options.allowedOrigins.includes(origin)) {
                return Response.json(
                    { jsonrpc: '2.0', error: { code: -32_000, message: `Invalid Origin header: ${origin}` }, id: null },
                    { status: 403 }
                );
            }
        }
        return undefined;
    }
}
