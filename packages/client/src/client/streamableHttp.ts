import type { ReadableWritablePair } from 'node:stream/web';

import type {
    FetchLike,
    JSONRPCErrorResponse,
    JSONRPCMessage,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResultResponse,
    Notification,
    Transport
} from '@modelcontextprotocol/core';
import {
    createFetchWithInit,
    isInitializedNotification,
    isJSONRPCErrorResponse,
    isJSONRPCNotification,
    isJSONRPCRequest,
    isJSONRPCResultResponse,
    JSONRPCMessageSchema,
    normalizeHeaders,
    SdkError,
    SdkErrorCode
} from '@modelcontextprotocol/core';
import { EventSourceParserStream } from 'eventsource-parser/stream';

import type { AuthProvider, OAuthClientProvider } from './auth.js';
import { adaptOAuthProvider, auth, extractWWWAuthenticateParams, isOAuthClientProvider, UnauthorizedError } from './auth.js';
import type { ClientFetchOptions, ClientTransport } from './clientTransport.js';

/**
 * @deprecated Use {@linkcode SdkError} with {@linkcode SdkErrorCode}. Kept for v1 import compatibility.
 */
export class StreamableHTTPError extends SdkError {
    constructor(
        public readonly statusCode: number | undefined,
        message: string
    ) {
        super(SdkErrorCode.ClientHttpUnexpectedContent, message);
    }
}

// Default reconnection options for StreamableHTTP connections
const DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS: StreamableHTTPReconnectionOptions = {
    initialReconnectionDelay: 1000,
    maxReconnectionDelay: 30_000,
    reconnectionDelayGrowFactor: 1.5,
    maxRetries: 2
};

/**
 * Options for starting or authenticating an SSE connection
 */
export interface StartSSEOptions {
    /**
     * The resumption token used to continue long-running requests that were interrupted.
     *
     * This allows clients to reconnect and continue from where they left off.
     */
    resumptionToken?: string;

    /**
     * A callback that is invoked when the resumption token changes.
     *
     * This allows clients to persist the latest token for potential reconnection.
     */
    onresumptiontoken?: (token: string) => void;

    /**
     * Override Message ID to associate with the replay message
     * so that the response can be associated with the new resumed request.
     */
    replayMessageId?: string | number;
}

/**
 * Configuration options for reconnection behavior of the {@linkcode StreamableHTTPClientTransport}.
 */
export interface StreamableHTTPReconnectionOptions {
    /**
     * Maximum backoff time between reconnection attempts in milliseconds.
     * Default is 30000 (30 seconds).
     */
    maxReconnectionDelay: number;

    /**
     * Initial backoff time between reconnection attempts in milliseconds.
     * Default is 1000 (1 second).
     */
    initialReconnectionDelay: number;

    /**
     * The factor by which the reconnection delay increases after each attempt.
     * Default is 1.5.
     */
    reconnectionDelayGrowFactor: number;

    /**
     * Maximum number of reconnection attempts before giving up.
     * Default is 2.
     */
    maxRetries: number;
}

/**
 * Custom scheduler for SSE stream reconnection attempts.
 *
 * Called instead of `setTimeout` when the transport needs to schedule a reconnection.
 * Useful in environments where `setTimeout` is unsuitable (serverless functions that
 * terminate before the timer fires, mobile apps that need platform background scheduling,
 * desktop apps handling sleep/wake).
 *
 * @param reconnect - Call this to perform the reconnection attempt.
 * @param delay - Suggested delay in milliseconds (from backoff calculation).
 * @param attemptCount - Zero-indexed retry attempt number.
 * @returns An optional cancel function. If returned, it will be called on
 * {@linkcode StreamableHTTPClientTransport.close | transport.close()} to abort the
 * pending reconnection.
 *
 * @example
 * ```ts source="./streamableHttp.examples.ts#ReconnectionScheduler_basicUsage"
 * const scheduler: ReconnectionScheduler = (reconnect, delay) => {
 *     const id = platformBackgroundTask.schedule(reconnect, delay);
 *     return () => platformBackgroundTask.cancel(id);
 * };
 * ```
 */
export type ReconnectionScheduler = (reconnect: () => void, delay: number, attemptCount: number) => (() => void) | void;

/**
 * Configuration options for the {@linkcode StreamableHTTPClientTransport}.
 */
export type StreamableHTTPClientTransportOptions = {
    /**
     * An OAuth client provider to use for authentication.
     *
     * {@linkcode AuthProvider.token | token()} is called before every request to obtain the
     * bearer token. When the server responds with 401, {@linkcode AuthProvider.onUnauthorized | onUnauthorized()}
     * is called (if provided) to refresh credentials, then the request is retried once. If
     * the retry also gets 401, or `onUnauthorized` is not provided, {@linkcode UnauthorizedError}
     * is thrown.
     *
     * For simple bearer tokens: `{ token: async () => myApiKey }`.
     *
     * For OAuth flows, pass an {@linkcode index.OAuthClientProvider | OAuthClientProvider} implementation
     * directly — the transport adapts it to `AuthProvider` internally. Interactive flows: after
     * {@linkcode UnauthorizedError}, redirect the user, then call
     * {@linkcode StreamableHTTPClientTransport.finishAuth | finishAuth} with the authorization code before
     * reconnecting.
     */
    authProvider?: AuthProvider | OAuthClientProvider;

    /**
     * Customizes HTTP requests to the server.
     */
    requestInit?: RequestInit;

    /**
     * Custom fetch implementation used for all network requests.
     */
    fetch?: FetchLike;

    /**
     * Options to configure the reconnection behavior.
     */
    reconnectionOptions?: StreamableHTTPReconnectionOptions;

    /**
     * Custom scheduler for reconnection attempts. If not provided, `setTimeout` is used.
     * See {@linkcode ReconnectionScheduler}.
     */
    reconnectionScheduler?: ReconnectionScheduler;

    /**
     * Session ID for the connection. This is used to identify the session on the server.
     * When not provided and connecting to a server that supports session IDs, the server will generate a new session ID.
     */
    sessionId?: string;

    /**
     * The MCP protocol version to include in the `mcp-protocol-version` header on all requests.
     * When reconnecting with a preserved `sessionId`, set this to the version negotiated during the original
     * handshake so the reconnected transport continues sending the required header.
     */
    protocolVersion?: string;
};

/**
 * Client transport for Streamable HTTP: this implements the MCP Streamable HTTP transport specification.
 * It will connect to a server using HTTP `POST` for sending messages and HTTP `GET` with Server-Sent Events
 * for receiving messages.
 *
 * Implements both the request-shaped {@linkcode ClientTransport} (the primary path used by
 * {@linkcode Client.connect}) and the legacy pipe-shaped {@linkcode Transport} (deprecated; kept for
 * direct callers and v1 compat).
 */
export class StreamableHTTPClientTransport implements ClientTransport, Transport {
    private _abortController?: AbortController;
    private _url: URL;
    private _resourceMetadataUrl?: URL;
    private _scope?: string;
    private _requestInit?: RequestInit;
    private _authProvider?: AuthProvider;
    private _oauthProvider?: OAuthClientProvider;
    private _fetch?: FetchLike;
    private _fetchWithInit: FetchLike;
    private _sessionId?: string;
    private _reconnectionOptions: StreamableHTTPReconnectionOptions;
    private _protocolVersion?: string;
    private _lastUpscopingHeader?: string; // Track last upscoping header to prevent infinite upscoping.
    private _serverRetryMs?: number; // Server-provided retry delay from SSE retry field
    private readonly _reconnectionScheduler?: ReconnectionScheduler;
    private _cancelReconnection?: () => void;

    /** @deprecated Pipe-shaped {@linkcode Transport} callback. The {@linkcode ClientTransport} path returns responses directly. */
    onclose?: () => void;
    /** @deprecated Pipe-shaped {@linkcode Transport} callback. */
    onerror?: (error: Error) => void;
    /** @deprecated Pipe-shaped {@linkcode Transport} callback. */
    onmessage?: (message: JSONRPCMessage) => void;

    constructor(url: URL, opts?: StreamableHTTPClientTransportOptions) {
        this._url = url;
        this._resourceMetadataUrl = undefined;
        this._scope = undefined;
        this._requestInit = opts?.requestInit;
        if (isOAuthClientProvider(opts?.authProvider)) {
            this._oauthProvider = opts.authProvider;
            this._authProvider = adaptOAuthProvider(opts.authProvider);
        } else {
            this._authProvider = opts?.authProvider;
        }
        this._fetch = opts?.fetch;
        this._fetchWithInit = createFetchWithInit(opts?.fetch, opts?.requestInit);
        this._sessionId = opts?.sessionId;
        this._protocolVersion = opts?.protocolVersion;
        this._reconnectionOptions = opts?.reconnectionOptions ?? DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS;
        this._reconnectionScheduler = opts?.reconnectionScheduler;
    }

    // ───────────────────────────────────────────────────────────────────────
    // Shared internals
    // ───────────────────────────────────────────────────────────────────────

    private async _commonHeaders(): Promise<Headers> {
        const headers: RequestInit['headers'] & Record<string, string> = {};
        const token = await this._authProvider?.token();
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        if (this._sessionId) {
            headers['mcp-session-id'] = this._sessionId;
        }
        if (this._protocolVersion) {
            headers['mcp-protocol-version'] = this._protocolVersion;
        }

        const extraHeaders = normalizeHeaders(this._requestInit?.headers);

        return new Headers({
            ...headers,
            ...extraHeaders
        });
    }

    /**
     * Single auth-aware HTTP request. Adds bearer header, captures session id, and
     * handles 401 (one retry via {@linkcode AuthProvider.onUnauthorized}) and 403
     * insufficient_scope (upscope via OAuth, with loop guard). Returns the Response
     * even when not-ok for status codes other than the handled auth cases.
     */
    private async _authedHttpFetch(
        build: (headers: Headers) => RequestInit,
        opts: { signal?: AbortSignal } = {},
        isAuthRetry = false
    ): Promise<Response> {
        const headers = await this._commonHeaders();
        const init = { ...this._requestInit, ...build(headers), signal: opts.signal ?? this._abortController?.signal };
        const response = await (this._fetch ?? fetch)(this._url, init);

        const sessionId = response.headers?.get('mcp-session-id');
        if (sessionId) {
            this._sessionId = sessionId;
        }
        if (response.ok) {
            this._lastUpscopingHeader = undefined;
            return response;
        }

        if (response.status === 401 && this._authProvider) {
            if (response.headers.has('www-authenticate')) {
                const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
                this._resourceMetadataUrl = resourceMetadataUrl;
                this._scope = scope;
            }
            if (this._authProvider.onUnauthorized && !isAuthRetry) {
                await this._authProvider.onUnauthorized({
                    response,
                    serverUrl: this._url,
                    fetchFn: this._fetchWithInit
                });
                await response.text?.().catch(() => {});
                return this._authedHttpFetch(build, opts, true);
            }
            await response.text?.().catch(() => {});
            if (isAuthRetry) {
                throw new SdkError(SdkErrorCode.ClientHttpAuthentication, 'Server returned 401 after re-authentication', { status: 401 });
            }
            throw new UnauthorizedError();
        }

        if (response.status === 403 && this._oauthProvider) {
            const text = await response.text?.().catch(() => null);
            const { resourceMetadataUrl, scope, error } = extractWWWAuthenticateParams(response);
            if (error === 'insufficient_scope') {
                const wwwAuthHeader = response.headers.get('WWW-Authenticate');
                if (this._lastUpscopingHeader === wwwAuthHeader) {
                    throw new SdkError(SdkErrorCode.ClientHttpForbidden, 'Server returned 403 after trying upscoping', {
                        status: 403,
                        text
                    });
                }
                if (scope) this._scope = scope;
                if (resourceMetadataUrl) this._resourceMetadataUrl = resourceMetadataUrl;
                this._lastUpscopingHeader = wwwAuthHeader ?? undefined;
                const result = await auth(this._oauthProvider, {
                    serverUrl: this._url,
                    resourceMetadataUrl: this._resourceMetadataUrl,
                    scope: this._scope,
                    fetchFn: this._fetchWithInit
                });
                if (result !== 'AUTHORIZED') {
                    throw new UnauthorizedError();
                }
                return this._authedHttpFetch(build, opts, isAuthRetry);
            }
            // Re-wrap consumed-body 403 so caller's `await response.text()` doesn't blow up.
            return new Response(text, { status: 403, headers: response.headers });
        }

        return response;
    }

    private _setAccept(headers: Headers, ...required: string[]): void {
        const userAccept = headers.get('accept');
        const types = [...(userAccept?.split(',').map(s => s.trim().toLowerCase()) ?? []), ...required];
        headers.set('accept', [...new Set(types)].join(', '));
    }

    /**
     * Calculates the next reconnection delay using a backoff algorithm
     *
     * @param attempt Current reconnection attempt count for the specific stream
     * @returns Time to wait in milliseconds before next reconnection attempt
     */
    private _getNextReconnectionDelay(attempt: number): number {
        if (this._serverRetryMs !== undefined) return this._serverRetryMs;
        const initialDelay = this._reconnectionOptions.initialReconnectionDelay;
        const growFactor = this._reconnectionOptions.reconnectionDelayGrowFactor;
        const maxDelay = this._reconnectionOptions.maxReconnectionDelay;
        return Math.min(initialDelay * Math.pow(growFactor, attempt), maxDelay);
    }

    private _sseReader(stream: ReadableStream<Uint8Array>) {
        return stream
            .pipeThrough(new TextDecoderStream() as ReadableWritablePair<string, Uint8Array>)
            .pipeThrough(new EventSourceParserStream({ onRetry: ms => (this._serverRetryMs = ms) }))
            .getReader();
    }

    private _linkSignal(a: AbortSignal | undefined): AbortSignal | undefined {
        const b = this._abortController?.signal;
        if (!a) return b;
        if (!b) return a;
        if (typeof (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any === 'function') {
            return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any([a, b]);
        }
        const c = new AbortController();
        const wire = (s: AbortSignal) =>
            s.aborted ? c.abort(s.reason) : s.addEventListener('abort', () => c.abort(s.reason), { once: true });
        wire(a);
        wire(b);
        return c.signal;
    }

    // ───────────────────────────────────────────────────────────────────────
    // ClientTransport (request-shaped) — primary path
    // ───────────────────────────────────────────────────────────────────────

    /**
     * Send one JSON-RPC request and resolve with the terminal response. Progress and other
     * notifications received before the response are surfaced via {@linkcode ClientFetchOptions}.
     */
    async fetch(request: JSONRPCRequest, opts: ClientFetchOptions = {}): Promise<JSONRPCResultResponse | JSONRPCErrorResponse> {
        this._abortController ??= new AbortController();
        return this._fetchOnce(request, opts, opts.resumptionToken, 0);
    }

    private async _fetchOnce(
        request: JSONRPCRequest,
        opts: ClientFetchOptions,
        lastEventId: string | undefined,
        attempt: number
    ): Promise<JSONRPCResultResponse | JSONRPCErrorResponse> {
        const signal = this._linkSignal(opts.signal);
        const isResume = lastEventId !== undefined;
        const res = await this._authedHttpFetch(
            headers => {
                if (isResume) {
                    this._setAccept(headers, 'text/event-stream');
                    headers.set('last-event-id', lastEventId);
                    return { method: 'GET', headers };
                }
                headers.set('content-type', 'application/json');
                this._setAccept(headers, 'application/json', 'text/event-stream');
                return { method: 'POST', headers, body: JSON.stringify(request) };
            },
            { signal }
        );

        if (!res.ok) {
            const text = await res.text?.().catch(() => null);
            throw new SdkError(SdkErrorCode.ClientHttpNotImplemented, `Error POSTing to endpoint (HTTP ${res.status}): ${text}`, {
                status: res.status,
                text
            });
        }
        const ct = res.headers.get('content-type') ?? '';
        if (ct.includes('text/event-stream')) {
            return this._readSseToTerminal(res, request, opts, attempt);
        }
        if (ct.includes('application/json')) {
            const data = await res.json();
            const messages = Array.isArray(data) ? data : [data];
            let terminal: JSONRPCResultResponse | JSONRPCErrorResponse | undefined;
            for (const m of messages) {
                const msg = JSONRPCMessageSchema.parse(m);
                if (isJSONRPCResultResponse(msg) || isJSONRPCErrorResponse(msg)) terminal = msg;
                else if (isJSONRPCNotification(msg)) this._routeFetchNotification(msg, opts);
            }
            if (!terminal) {
                throw new SdkError(SdkErrorCode.ClientHttpUnexpectedContent, 'JSON response contained no terminal response');
            }
            return terminal;
        }
        await res.text?.().catch(() => {});
        throw new SdkError(SdkErrorCode.ClientHttpUnexpectedContent, `Unexpected content type: ${ct}`, { contentType: ct });
    }

    private async _readSseToTerminal(
        res: Response,
        request: JSONRPCRequest,
        opts: ClientFetchOptions,
        attempt: number
    ): Promise<JSONRPCResultResponse | JSONRPCErrorResponse> {
        if (!res.body) throw new SdkError(SdkErrorCode.ClientHttpUnexpectedContent, 'SSE response has no body');
        let lastEventId: string | undefined;
        let primed = false;
        const reader = this._sseReader(res.body);
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value.id) {
                    lastEventId = value.id;
                    primed = true;
                    opts.onresumptiontoken?.(value.id);
                }
                if (!value.data) continue;
                if (value.event && value.event !== 'message') continue;
                const msg = JSONRPCMessageSchema.parse(JSON.parse(value.data));
                if (isJSONRPCResultResponse(msg) || isJSONRPCErrorResponse(msg)) {
                    if (msg.id === request.id) return msg;
                    opts.onresponse?.(msg);
                    continue;
                }
                if (isJSONRPCNotification(msg)) {
                    this._routeFetchNotification(msg, opts);
                } else if (isJSONRPCRequest(msg)) {
                    void this._serviceInboundRequest(msg, opts);
                }
            }
        } catch {
            // fallthrough to resume below
        } finally {
            try {
                reader.releaseLock();
            } catch {
                /* noop */
            }
        }
        if (primed && attempt < this._reconnectionOptions.maxRetries && !this._abortController?.signal.aborted && !opts.signal?.aborted) {
            await new Promise(r => setTimeout(r, this._getNextReconnectionDelay(attempt)));
            return this._fetchOnce(request, opts, lastEventId, attempt + 1);
        }
        throw new SdkError(SdkErrorCode.ClientHttpFailedToOpenStream, 'SSE stream ended without a terminal response');
    }

    /** Handle a server-initiated request received on the SSE response stream and POST the reply back. */
    private async _serviceInboundRequest(
        inbound: JSONRPCRequest,
        opts: Pick<ClientFetchOptions, 'onrequest' | 'onnotification'>
    ): Promise<void> {
        if (!opts.onrequest) {
            opts.onnotification?.(inbound as unknown as JSONRPCNotification);
            return;
        }
        let response: JSONRPCResultResponse | JSONRPCErrorResponse;
        try {
            response = await opts.onrequest(inbound);
        } catch (error) {
            response = {
                jsonrpc: '2.0',
                id: inbound.id,
                error: { code: -32_603, message: error instanceof Error ? error.message : String(error) }
            };
        }
        try {
            const r = await this._authedHttpFetch(headers => {
                headers.set('content-type', 'application/json');
                this._setAccept(headers, 'application/json', 'text/event-stream');
                return { method: 'POST', headers, body: JSON.stringify(response) };
            });
            await r.text?.().catch(() => {});
        } catch (error) {
            this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        }
    }

    private _routeFetchNotification(msg: JSONRPCNotification, opts: ClientFetchOptions): void {
        if (msg.method === 'notifications/progress' && opts.onprogress) {
            const { progressToken: _t, ...progress } = (msg.params ?? {}) as Record<string, unknown>;
            void _t;
            opts.onprogress(progress as never);
            return;
        }
        opts.onnotification?.(msg);
    }

    /** Send a fire-and-forget JSON-RPC notification. */
    async notify(n: Notification): Promise<void> {
        this._abortController ??= new AbortController();
        const res = await this._authedHttpFetch(headers => {
            headers.set('content-type', 'application/json');
            this._setAccept(headers, 'application/json', 'text/event-stream');
            return { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: n.method, params: n.params }) };
        });
        await res.text?.().catch(() => {});
        if (!res.ok && res.status !== 202) {
            throw new SdkError(SdkErrorCode.ClientHttpNotImplemented, `Notification POST failed: ${res.status}`, { status: res.status });
        }
    }

    /**
     * Open the standalone GET SSE stream and yield server-initiated notifications.
     * Inbound requests (elicitation/sampling/roots) are dispatched via
     * {@linkcode ClientFetchOptions.onrequest | opts.onrequest} and the reply is
     * POSTed back automatically. Best-effort: if the server replies 405 (no SSE
     * GET), the iterable completes immediately.
     */
    async *subscribe(opts: Pick<ClientFetchOptions, 'onrequest' | 'onresponse'> = {}): AsyncIterable<JSONRPCNotification> {
        this._abortController ??= new AbortController();
        const res = await this._authedHttpFetch(headers => {
            this._setAccept(headers, 'text/event-stream');
            return { method: 'GET', headers };
        });
        if (res.status === 405 || !res.ok || !res.body) {
            await res.text?.().catch(() => {});
            return;
        }
        const reader = this._sseReader(res.body);
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) return;
                if (!value.data) continue;
                const msg = JSONRPCMessageSchema.parse(JSON.parse(value.data));
                if (isJSONRPCNotification(msg)) {
                    yield msg;
                } else if (isJSONRPCRequest(msg)) {
                    void this._serviceInboundRequest(msg, opts);
                } else if (isJSONRPCResultResponse(msg) || isJSONRPCErrorResponse(msg)) {
                    opts.onresponse?.(msg);
                }
            }
        } finally {
            reader.releaseLock();
        }
    }

    // ───────────────────────────────────────────────────────────────────────
    // Transport (pipe-shaped) — deprecated compat surface
    // ───────────────────────────────────────────────────────────────────────

    private async _startOrAuthSse(options: StartSSEOptions): Promise<void> {
        const { resumptionToken } = options;
        try {
            const response = await this._authedHttpFetch(headers => {
                this._setAccept(headers, 'text/event-stream');
                if (resumptionToken) headers.set('last-event-id', resumptionToken);
                return { method: 'GET', headers };
            });

            if (!response.ok) {
                await response.text?.().catch(() => {});
                // 405 indicates that the server does not offer an SSE stream at GET endpoint
                if (response.status === 405) return;
                throw new SdkError(SdkErrorCode.ClientHttpFailedToOpenStream, `Failed to open SSE stream: ${response.statusText}`, {
                    status: response.status,
                    statusText: response.statusText
                });
            }
            this._handleSseStream(response.body, options, true);
        } catch (error) {
            this.onerror?.(error as Error);
            throw error;
        }
    }

    /**
     * Schedule a reconnection attempt using server-provided retry interval or backoff
     */
    private _scheduleReconnection(options: StartSSEOptions, attemptCount = 0): void {
        const maxRetries = this._reconnectionOptions.maxRetries;
        if (attemptCount >= maxRetries) {
            this.onerror?.(new Error(`Maximum reconnection attempts (${maxRetries}) exceeded.`));
            return;
        }
        const delay = this._getNextReconnectionDelay(attemptCount);
        const reconnect = (): void => {
            this._cancelReconnection = undefined;
            if (this._abortController?.signal.aborted) return;
            this._startOrAuthSse(options).catch(error => {
                this.onerror?.(new Error(`Failed to reconnect SSE stream: ${error instanceof Error ? error.message : String(error)}`));
                try {
                    this._scheduleReconnection(options, attemptCount + 1);
                } catch (scheduleError) {
                    this.onerror?.(scheduleError instanceof Error ? scheduleError : new Error(String(scheduleError)));
                }
            });
        };
        if (this._reconnectionScheduler) {
            const cancel = this._reconnectionScheduler(reconnect, delay, attemptCount);
            this._cancelReconnection = typeof cancel === 'function' ? cancel : undefined;
        } else {
            const handle = setTimeout(reconnect, delay);
            this._cancelReconnection = () => clearTimeout(handle);
        }
    }

    private _handleSseStream(stream: ReadableStream<Uint8Array> | null, options: StartSSEOptions, isReconnectable: boolean): void {
        if (!stream) return;
        const { onresumptiontoken, replayMessageId } = options;

        let lastEventId: string | undefined;
        let hasPrimingEvent = false;
        let receivedResponse = false;
        const processStream = async () => {
            try {
                const reader = this._sseReader(stream);
                while (true) {
                    const { value: event, done } = await reader.read();
                    if (done) break;
                    if (event.id) {
                        lastEventId = event.id;
                        hasPrimingEvent = true;
                        onresumptiontoken?.(event.id);
                    }
                    if (!event.data) continue;
                    if (!event.event || event.event === 'message') {
                        try {
                            const message = JSONRPCMessageSchema.parse(JSON.parse(event.data));
                            if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
                                receivedResponse = true;
                                if (replayMessageId !== undefined) {
                                    message.id = replayMessageId;
                                }
                            }
                            this.onmessage?.(message);
                        } catch (error) {
                            this.onerror?.(error as Error);
                        }
                    }
                }
                const canResume = isReconnectable || hasPrimingEvent;
                const needsReconnect = canResume && !receivedResponse;
                if (needsReconnect && this._abortController && !this._abortController.signal.aborted) {
                    this._scheduleReconnection({ resumptionToken: lastEventId, onresumptiontoken, replayMessageId }, 0);
                }
            } catch (error) {
                this.onerror?.(new Error(`SSE stream disconnected: ${error}`));
                const canResume = isReconnectable || hasPrimingEvent;
                const needsReconnect = canResume && !receivedResponse;
                if (needsReconnect && this._abortController && !this._abortController.signal.aborted) {
                    try {
                        this._scheduleReconnection({ resumptionToken: lastEventId, onresumptiontoken, replayMessageId }, 0);
                    } catch (error) {
                        this.onerror?.(new Error(`Failed to reconnect: ${error instanceof Error ? error.message : String(error)}`));
                    }
                }
            }
        };
        processStream();
    }

    /** @deprecated Part of the pipe-shaped {@linkcode Transport} interface. {@linkcode Client.connect} uses the request-shaped path. */
    async start() {
        if (this._abortController) {
            throw new Error(
                'StreamableHTTPClientTransport already started! If using Client class, note that connect() calls start() automatically.'
            );
        }
        this._abortController = new AbortController();
    }

    /**
     * Call this method after the user has finished authorizing via their user agent and is redirected back to the MCP client application. This will exchange the authorization code for an access token, enabling the next connection attempt to successfully auth.
     */
    async finishAuth(authorizationCode: string): Promise<void> {
        if (!this._oauthProvider) {
            throw new UnauthorizedError('finishAuth requires an OAuthClientProvider');
        }
        const result = await auth(this._oauthProvider, {
            serverUrl: this._url,
            authorizationCode,
            resourceMetadataUrl: this._resourceMetadataUrl,
            scope: this._scope,
            fetchFn: this._fetchWithInit
        });
        if (result !== 'AUTHORIZED') {
            throw new UnauthorizedError('Failed to authorize');
        }
    }

    async close(): Promise<void> {
        try {
            this._cancelReconnection?.();
        } finally {
            this._cancelReconnection = undefined;
            this._abortController?.abort();
            this.onclose?.();
        }
    }

    /** @deprecated Part of the pipe-shaped {@linkcode Transport} interface. Use {@linkcode fetch} / {@linkcode notify}. */
    async send(
        message: JSONRPCMessage | JSONRPCMessage[],
        options?: { resumptionToken?: string; onresumptiontoken?: (token: string) => void }
    ): Promise<void> {
        try {
            const { resumptionToken, onresumptiontoken } = options || {};

            if (resumptionToken) {
                this._startOrAuthSse({ resumptionToken, replayMessageId: isJSONRPCRequest(message) ? message.id : undefined }).catch(
                    error => this.onerror?.(error)
                );
                return;
            }

            const response = await this._authedHttpFetch(headers => {
                headers.set('content-type', 'application/json');
                this._setAccept(headers, 'application/json', 'text/event-stream');
                return { method: 'POST', headers, body: JSON.stringify(message) };
            });

            if (!response.ok) {
                const text = await response.text?.().catch(() => null);
                throw new SdkError(SdkErrorCode.ClientHttpNotImplemented, `Error POSTing to endpoint: ${text}`, {
                    status: response.status,
                    text
                });
            }

            if (response.status === 202) {
                await response.text?.().catch(() => {});
                if (isInitializedNotification(message)) {
                    this._startOrAuthSse({ resumptionToken: undefined }).catch(error => this.onerror?.(error));
                }
                return;
            }

            const messages = Array.isArray(message) ? message : [message];
            const hasRequests = messages.some(msg => 'method' in msg && 'id' in msg && msg.id !== undefined);
            const contentType = response.headers.get('content-type');

            if (hasRequests) {
                if (contentType?.includes('text/event-stream')) {
                    this._handleSseStream(response.body, { onresumptiontoken }, false);
                } else if (contentType?.includes('application/json')) {
                    const data = await response.json();
                    const responseMessages = Array.isArray(data)
                        ? data.map(msg => JSONRPCMessageSchema.parse(msg))
                        : [JSONRPCMessageSchema.parse(data)];
                    for (const msg of responseMessages) {
                        this.onmessage?.(msg);
                    }
                } else {
                    await response.text?.().catch(() => {});
                    throw new SdkError(SdkErrorCode.ClientHttpUnexpectedContent, `Unexpected content type: ${contentType}`, {
                        contentType
                    });
                }
            } else {
                await response.text?.().catch(() => {});
            }
        } catch (error) {
            this.onerror?.(error as Error);
            throw error;
        }
    }

    get sessionId(): string | undefined {
        return this._sessionId;
    }

    /**
     * Terminates the current session by sending a `DELETE` request to the server.
     *
     * Clients that no longer need a particular session
     * (e.g., because the user is leaving the client application) SHOULD send an
     * HTTP `DELETE` to the MCP endpoint with the `Mcp-Session-Id` header to explicitly
     * terminate the session.
     *
     * The server MAY respond with HTTP `405 Method Not Allowed`, indicating that
     * the server does not allow clients to terminate sessions.
     */
    async terminateSession(): Promise<void> {
        if (!this._sessionId) return;
        try {
            const response = await this._authedHttpFetch(headers => ({ method: 'DELETE', headers }));
            await response.text?.().catch(() => {});
            if (!response.ok && response.status !== 405) {
                throw new SdkError(SdkErrorCode.ClientHttpFailedToTerminateSession, `Failed to terminate session: ${response.statusText}`, {
                    status: response.status,
                    statusText: response.statusText
                });
            }
            this._sessionId = undefined;
        } catch (error) {
            this.onerror?.(error as Error);
            throw error;
        }
    }

    setProtocolVersion(version: string): void {
        this._protocolVersion = version;
    }
    get protocolVersion(): string | undefined {
        return this._protocolVersion;
    }

    /**
     * Resume an SSE stream from a previous event ID.
     * Opens a `GET` SSE connection with `Last-Event-ID` header to replay missed events.
     *
     * @deprecated Part of the pipe-shaped {@linkcode Transport} surface; messages surface via {@linkcode onmessage}.
     */
    async resumeStream(lastEventId: string, options?: { onresumptiontoken?: (token: string) => void }): Promise<void> {
        await this._startOrAuthSse({ resumptionToken: lastEventId, onresumptiontoken: options?.onresumptiontoken });
    }
}
