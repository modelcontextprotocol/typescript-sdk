import type { ReadableWritablePair } from 'node:stream/web';

import type { FetchLike, JSONRPCMessage, Transport } from '@modelcontextprotocol/core';
import {
    createFetchWithInit,
    isInitializedNotification,
    isJSONRPCErrorResponse,
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

// Default reconnection options for StreamableHTTP connections
const DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS: StreamableHTTPReconnectionOptions = {
    initialReconnectionDelay: 1000,
    maxReconnectionDelay: 30_000,
    reconnectionDelayGrowFactor: 1.5,
    maxRetries: 2
};

// Default behaviour when the server responds with HTTP 429 Too Many Requests.
// `maxRetries` keeps total wait time bounded; `maxRetryAfterMs` caps any
// individual `Retry-After` value so a malicious or misconfigured server cannot
// make the client sleep for hours. `defaultRetryAfterMs` is used when the 429
// response omits `Retry-After` entirely.
const DEFAULT_STREAMABLE_HTTP_RATE_LIMIT_OPTIONS: StreamableHTTPRateLimitOptions = {
    maxRetries: 3,
    defaultRetryAfterMs: 1_000,
    maxRetryAfterMs: 60_000
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
 * Configuration options controlling how the {@linkcode StreamableHTTPClientTransport}
 * reacts to HTTP `429 Too Many Requests` responses.
 *
 * On 429 the transport waits for the duration indicated by the response's
 * `Retry-After` header (delta-seconds or HTTP-date per RFC 7231 §7.1.3) and
 * then retries the original request. If the header is missing, malformed, or
 * exceeds {@linkcode maxRetryAfterMs}, the transport falls back to
 * {@linkcode defaultRetryAfterMs}. Once {@linkcode maxRetries} consecutive
 * 429 responses have been received the transport throws
 * {@linkcode SdkErrorCode.ClientHttpRateLimited}.
 *
 * Pass `{ maxRetries: 0 }` to disable automatic 429 retries entirely (useful
 * if the application has its own rate-limit handling).
 */
export interface StreamableHTTPRateLimitOptions {
    /**
     * Maximum number of automatic retries after consecutive 429 responses.
     * Set to 0 to disable retrying. Default is 3.
     */
    maxRetries: number;

    /**
     * Delay in milliseconds to use when the 429 response omits or has an
     * unparsable `Retry-After` header. Default is 1000 (1 second).
     */
    defaultRetryAfterMs: number;

    /**
     * Upper bound, in milliseconds, on any single retry delay. If the server
     * provides a larger `Retry-After` value, it is clamped to this. Default
     * is 60000 (60 seconds).
     */
    maxRetryAfterMs: number;
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
     * Options controlling how the transport reacts to HTTP `429 Too Many
     * Requests` responses (Retry-After parsing, retry caps).
     * See {@linkcode StreamableHTTPRateLimitOptions}.
     */
    rateLimitOptions?: StreamableHTTPRateLimitOptions;

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
 */
export class StreamableHTTPClientTransport implements Transport {
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
    private _rateLimitOptions: StreamableHTTPRateLimitOptions;
    private _protocolVersion?: string;
    private _lastUpscopingHeader?: string; // Track last upscoping header to prevent infinite upscoping.
    private _serverRetryMs?: number; // Server-provided retry delay from SSE retry field
    private readonly _reconnectionScheduler?: ReconnectionScheduler;
    private _cancelReconnection?: () => void;

    onclose?: () => void;
    onerror?: (error: Error) => void;
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
        this._rateLimitOptions = opts?.rateLimitOptions ?? DEFAULT_STREAMABLE_HTTP_RATE_LIMIT_OPTIONS;
        this._reconnectionScheduler = opts?.reconnectionScheduler;
    }

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
     * Parses an HTTP `Retry-After` header value (RFC 7231 §7.1.3). Accepts
     * either a non-negative integer of seconds or an HTTP-date.
     *
     * @returns The retry delay in milliseconds, or `undefined` if the value
     * is missing/unparseable or refers to a moment in the past.
     */
    private static _parseRetryAfter(headerValue: string | null | undefined): number | undefined {
        if (headerValue == null) {
            return undefined;
        }
        const trimmed = headerValue.trim();
        if (trimmed.length === 0) {
            return undefined;
        }
        // delta-seconds — the spec only requires non-negative integers, but we
        // accept fractional seconds too because some servers emit them.
        if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
            const seconds = Number(trimmed);
            if (Number.isFinite(seconds) && seconds >= 0) {
                return Math.round(seconds * 1000);
            }
            return undefined;
        }
        // HTTP-date — fall back to Date parsing. `Date.parse` is locale-tolerant
        // enough for the IMF-fixdate / RFC 850 / asctime variants required by
        // RFC 7231 in practice.
        const dateMs = Date.parse(trimmed);
        if (!Number.isFinite(dateMs)) {
            return undefined;
        }
        const delta = dateMs - Date.now();
        return delta > 0 ? delta : 0;
    }

    /**
     * Inspects a 429 response and returns the delay (in ms) the client should
     * wait before retrying, applying configured caps and fallbacks. Returns
     * `null` if retries are disabled or exhausted.
     */
    private _getRateLimitRetryDelay(response: Response, attempt: number): number | null {
        const { maxRetries, defaultRetryAfterMs, maxRetryAfterMs } = this._rateLimitOptions;
        if (maxRetries <= 0 || attempt >= maxRetries) {
            return null;
        }
        const headerDelay = StreamableHTTPClientTransport._parseRetryAfter(response.headers.get('retry-after'));
        const delay = headerDelay ?? defaultRetryAfterMs;
        return Math.min(Math.max(delay, 0), maxRetryAfterMs);
    }

    /**
     * Sleep for `ms` milliseconds, aborting early if the transport's
     * AbortController fires. The returned promise rejects with the abort
     * reason in that case so the surrounding fetch loop bails out cleanly.
     */
    private _sleepWithAbort(ms: number): Promise<void> {
        const signal = this._abortController?.signal;
        return new Promise<void>((resolve, reject) => {
            if (signal?.aborted) {
                reject(signal.reason ?? new Error('Aborted'));
                return;
            }
            const timer = setTimeout(() => {
                signal?.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            const onAbort = () => {
                clearTimeout(timer);
                reject(signal?.reason ?? new Error('Aborted'));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    private async _startOrAuthSse(options: StartSSEOptions, isAuthRetry = false): Promise<void> {
        const { resumptionToken } = options;

        try {
            // Try to open an initial SSE stream with GET to listen for server messages
            // This is optional according to the spec - server may not support it
            const headers = await this._commonHeaders();
            const userAccept = headers.get('accept');
            const types = [...(userAccept?.split(',').map(s => s.trim().toLowerCase()) ?? []), 'text/event-stream'];
            headers.set('accept', [...new Set(types)].join(', '));

            // Include Last-Event-ID header for resumable streams if provided
            if (resumptionToken) {
                headers.set('last-event-id', resumptionToken);
            }

            // Issue the GET, retrying on 429 honouring `Retry-After`. All other
            // status handling stays in the existing branches below.
            const doGet = () =>
                (this._fetch ?? fetch)(this._url, {
                    ...this._requestInit,
                    method: 'GET',
                    headers,
                    signal: this._abortController?.signal
                });
            let response = await doGet();
            let rateLimitAttempt = 0;
            while (response.status === 429) {
                const delay = this._getRateLimitRetryDelay(response, rateLimitAttempt);
                if (delay === null) {
                    // Retries exhausted (or disabled) — surface as a typed error.
                    await response.text?.().catch(() => {});
                    throw new SdkError(
                        SdkErrorCode.ClientHttpRateLimited,
                        `Server returned 429 after ${rateLimitAttempt} retr${rateLimitAttempt === 1 ? 'y' : 'ies'}`,
                        {
                            status: 429,
                            retryAfter: response.headers.get('retry-after')
                        }
                    );
                }
                await response.text?.().catch(() => {});
                rateLimitAttempt += 1;
                await this._sleepWithAbort(delay);
                response = await doGet();
            }

            if (!response.ok) {
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
                        // Purposely _not_ awaited, so we don't call onerror twice
                        return this._startOrAuthSse(options, true);
                    }
                    await response.text?.().catch(() => {});
                    if (isAuthRetry) {
                        throw new SdkError(SdkErrorCode.ClientHttpAuthentication, 'Server returned 401 after re-authentication', {
                            status: 401
                        });
                    }
                    throw new UnauthorizedError();
                }

                await response.text?.().catch(() => {});

                // 405 indicates that the server does not offer an SSE stream at GET endpoint
                // This is an expected case that should not trigger an error
                if (response.status === 405) {
                    return;
                }

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
     * Calculates the next reconnection delay using a backoff algorithm
     *
     * @param attempt Current reconnection attempt count for the specific stream
     * @returns Time to wait in milliseconds before next reconnection attempt
     */
    private _getNextReconnectionDelay(attempt: number): number {
        // Use server-provided retry value if available
        if (this._serverRetryMs !== undefined) {
            return this._serverRetryMs;
        }

        // Fall back to exponential backoff
        const initialDelay = this._reconnectionOptions.initialReconnectionDelay;
        const growFactor = this._reconnectionOptions.reconnectionDelayGrowFactor;
        const maxDelay = this._reconnectionOptions.maxReconnectionDelay;

        // Cap at maximum delay
        return Math.min(initialDelay * Math.pow(growFactor, attempt), maxDelay);
    }

    /**
     * Schedule a reconnection attempt using server-provided retry interval or backoff
     *
     * @param lastEventId The ID of the last received event for resumability
     * @param attemptCount Current reconnection attempt count for this specific stream
     */
    private _scheduleReconnection(options: StartSSEOptions, attemptCount = 0): void {
        // Use provided options or default options
        const maxRetries = this._reconnectionOptions.maxRetries;

        // Check if we've exceeded maximum retry attempts
        if (attemptCount >= maxRetries) {
            this.onerror?.(new Error(`Maximum reconnection attempts (${maxRetries}) exceeded.`));
            return;
        }

        // Calculate next delay based on current attempt count
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
        if (!stream) {
            return;
        }
        const { onresumptiontoken, replayMessageId } = options;

        let lastEventId: string | undefined;
        // Track whether we've received a priming event (event with ID)
        // Per spec, server SHOULD send a priming event with ID before closing
        let hasPrimingEvent = false;
        // Track whether we've received a response - if so, no need to reconnect
        // Reconnection is for when server disconnects BEFORE sending response
        let receivedResponse = false;
        const processStream = async () => {
            // this is the closest we can get to trying to catch network errors
            // if something happens reader will throw
            try {
                // Create a pipeline: binary stream -> text decoder -> SSE parser
                const reader = stream
                    .pipeThrough(new TextDecoderStream() as ReadableWritablePair<string, Uint8Array>)
                    .pipeThrough(
                        new EventSourceParserStream({
                            onRetry: (retryMs: number) => {
                                // Capture server-provided retry value for reconnection timing
                                this._serverRetryMs = retryMs;
                            }
                        })
                    )
                    .getReader();

                while (true) {
                    const { value: event, done } = await reader.read();
                    if (done) {
                        break;
                    }

                    // Update last event ID if provided
                    if (event.id) {
                        lastEventId = event.id;
                        // Mark that we've received a priming event - stream is now resumable
                        hasPrimingEvent = true;
                        onresumptiontoken?.(event.id);
                    }

                    // Skip events with no data (priming events, keep-alives)
                    if (!event.data) {
                        continue;
                    }

                    if (!event.event || event.event === 'message') {
                        try {
                            const message = JSONRPCMessageSchema.parse(JSON.parse(event.data));
                            // Handle both success AND error responses for completion detection and ID remapping
                            if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
                                // Mark that we received a response - no need to reconnect for this request
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

                // Handle graceful server-side disconnect
                // Server may close connection after sending event ID and retry field
                // Reconnect if: already reconnectable (GET stream) OR received a priming event (POST stream with event ID)
                // BUT don't reconnect if we already received a response - the request is complete
                const canResume = isReconnectable || hasPrimingEvent;
                const needsReconnect = canResume && !receivedResponse;
                if (needsReconnect && this._abortController && !this._abortController.signal.aborted) {
                    this._scheduleReconnection(
                        {
                            resumptionToken: lastEventId,
                            onresumptiontoken,
                            replayMessageId
                        },
                        0
                    );
                }
            } catch (error) {
                // Handle stream errors - likely a network disconnect
                this.onerror?.(new Error(`SSE stream disconnected: ${error}`));

                // Attempt to reconnect if the stream disconnects unexpectedly and we aren't closing
                // Reconnect if: already reconnectable (GET stream) OR received a priming event (POST stream with event ID)
                // BUT don't reconnect if we already received a response - the request is complete
                const canResume = isReconnectable || hasPrimingEvent;
                const needsReconnect = canResume && !receivedResponse;
                if (needsReconnect && this._abortController && !this._abortController.signal.aborted) {
                    // Use the exponential backoff reconnection strategy
                    try {
                        this._scheduleReconnection(
                            {
                                resumptionToken: lastEventId,
                                onresumptiontoken,
                                replayMessageId
                            },
                            0
                        );
                    } catch (error) {
                        this.onerror?.(new Error(`Failed to reconnect: ${error instanceof Error ? error.message : String(error)}`));
                    }
                }
            }
        };
        processStream();
    }

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

    async send(
        message: JSONRPCMessage | JSONRPCMessage[],
        options?: { resumptionToken?: string; onresumptiontoken?: (token: string) => void }
    ): Promise<void> {
        return this._send(message, options, false);
    }

    private async _send(
        message: JSONRPCMessage | JSONRPCMessage[],
        options: { resumptionToken?: string; onresumptiontoken?: (token: string) => void } | undefined,
        isAuthRetry: boolean
    ): Promise<void> {
        try {
            const { resumptionToken, onresumptiontoken } = options || {};

            if (resumptionToken) {
                // If we have a last event ID, we need to reconnect the SSE stream
                this._startOrAuthSse({ resumptionToken, replayMessageId: isJSONRPCRequest(message) ? message.id : undefined }).catch(
                    error => this.onerror?.(error)
                );
                return;
            }

            const headers = await this._commonHeaders();
            headers.set('content-type', 'application/json');
            const userAccept = headers.get('accept');
            const types = [...(userAccept?.split(',').map(s => s.trim().toLowerCase()) ?? []), 'application/json', 'text/event-stream'];
            headers.set('accept', [...new Set(types)].join(', '));

            const init = {
                ...this._requestInit,
                method: 'POST',
                headers,
                body: JSON.stringify(message),
                signal: this._abortController?.signal
            };

            // Retry POST on 429 honouring `Retry-After`; non-429 responses fall
            // through to the existing branches below for normal handling.
            let response = await (this._fetch ?? fetch)(this._url, init);
            let rateLimitAttempt = 0;
            while (response.status === 429) {
                const delay = this._getRateLimitRetryDelay(response, rateLimitAttempt);
                if (delay === null) {
                    const text = await response.text?.().catch(() => null);
                    throw new SdkError(
                        SdkErrorCode.ClientHttpRateLimited,
                        `Server returned 429 after ${rateLimitAttempt} retr${rateLimitAttempt === 1 ? 'y' : 'ies'}`,
                        {
                            status: 429,
                            retryAfter: response.headers.get('retry-after'),
                            text
                        }
                    );
                }
                await response.text?.().catch(() => {});
                rateLimitAttempt += 1;
                await this._sleepWithAbort(delay);
                response = await (this._fetch ?? fetch)(this._url, init);
            }

            // Handle session ID received during initialization
            const sessionId = response.headers.get('mcp-session-id');
            if (sessionId) {
                this._sessionId = sessionId;
            }

            if (!response.ok) {
                if (response.status === 401 && this._authProvider) {
                    // Store WWW-Authenticate params for interactive finishAuth() path
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
                        // Purposely _not_ awaited, so we don't call onerror twice
                        return this._send(message, options, true);
                    }
                    await response.text?.().catch(() => {});
                    if (isAuthRetry) {
                        throw new SdkError(SdkErrorCode.ClientHttpAuthentication, 'Server returned 401 after re-authentication', {
                            status: 401
                        });
                    }
                    throw new UnauthorizedError();
                }

                const text = await response.text?.().catch(() => null);

                if (response.status === 403 && this._oauthProvider) {
                    const { resourceMetadataUrl, scope, error } = extractWWWAuthenticateParams(response);

                    if (error === 'insufficient_scope') {
                        const wwwAuthHeader = response.headers.get('WWW-Authenticate');

                        // Check if we've already tried upscoping with this header to prevent infinite loops.
                        if (this._lastUpscopingHeader === wwwAuthHeader) {
                            throw new SdkError(SdkErrorCode.ClientHttpForbidden, 'Server returned 403 after trying upscoping', {
                                status: 403,
                                text
                            });
                        }

                        if (scope) {
                            this._scope = scope;
                        }

                        if (resourceMetadataUrl) {
                            this._resourceMetadataUrl = resourceMetadataUrl;
                        }

                        // Mark that upscoping was tried.
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

                        return this._send(message, options, isAuthRetry);
                    }
                }

                throw new SdkError(SdkErrorCode.ClientHttpNotImplemented, `Error POSTing to endpoint: ${text}`, {
                    status: response.status,
                    text
                });
            }

            this._lastUpscopingHeader = undefined;

            // If the response is 202 Accepted, there's no body to process
            if (response.status === 202) {
                await response.text?.().catch(() => {});
                // if the accepted notification is initialized, we start the SSE stream
                // if it's supported by the server
                if (isInitializedNotification(message)) {
                    // Start without a lastEventId since this is a fresh connection
                    this._startOrAuthSse({ resumptionToken: undefined }).catch(error => this.onerror?.(error));
                }
                return;
            }

            // Get original message(s) for detecting request IDs
            const messages = Array.isArray(message) ? message : [message];

            const hasRequests = messages.some(msg => 'method' in msg && 'id' in msg && msg.id !== undefined);

            // Check the response type
            const contentType = response.headers.get('content-type');

            if (hasRequests) {
                if (contentType?.includes('text/event-stream')) {
                    // Handle SSE stream responses for requests
                    // We use the same handler as standalone streams, which now supports
                    // reconnection with the last event ID
                    this._handleSseStream(response.body, { onresumptiontoken }, false);
                } else if (contentType?.includes('application/json')) {
                    // For non-streaming servers, we might get direct JSON responses
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
                // No requests in message but got 200 OK - still need to release connection
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
        if (!this._sessionId) {
            return; // No session to terminate
        }

        try {
            const headers = await this._commonHeaders();

            const init = {
                ...this._requestInit,
                method: 'DELETE',
                headers,
                signal: this._abortController?.signal
            };

            const response = await (this._fetch ?? fetch)(this._url, init);
            await response.text?.().catch(() => {});

            // We specifically handle 405 as a valid response according to the spec,
            // meaning the server does not support explicit session termination
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
     * @param lastEventId The event ID to resume from
     * @param options Optional callback to receive new resumption tokens
     */
    async resumeStream(lastEventId: string, options?: { onresumptiontoken?: (token: string) => void }): Promise<void> {
        await this._startOrAuthSse({
            resumptionToken: lastEventId,
            onresumptiontoken: options?.onresumptiontoken
        });
    }
}
