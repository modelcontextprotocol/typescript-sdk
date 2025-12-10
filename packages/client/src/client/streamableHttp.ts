import { Transport, FetchLike, createFetchWithInit, normalizeHeaders } from '../shared/transport.js';
import { isInitializedNotification, isJSONRPCRequest, isJSONRPCResultResponse, JSONRPCMessage, JSONRPCMessageSchema } from '../types.js';
import { auth, AuthResult, extractWWWAuthenticateParams, OAuthClientProvider, UnauthorizedError } from './auth.js';
import { EventSourceParserStream } from 'eventsource-parser/stream';

// Default reconnection options for StreamableHTTP connections
const DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS: StreamableHTTPReconnectionOptions = {
    initialReconnectionDelay: 1000,
    maxReconnectionDelay: 30000,
    reconnectionDelayGrowFactor: 1.5,
    maxRetries: 2
};

export class StreamableHTTPError extends Error {
    constructor(
        public readonly code: number | undefined,
        message: string | undefined
    ) {
        super(`Streamable HTTP error: ${message}`);
    }
}

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
     * so that response can be associate with the new resumed request.
     */
    replayMessageId?: string | number;
}

/**
 * Configuration options for reconnection behavior of the StreamableHTTPClientTransport.
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
 * Configuration options for the `StreamableHTTPClientTransport`.
 */
export type StreamableHTTPClientTransportOptions = {
    /**
     * An OAuth client provider to use for authentication.
     *
     * When an `authProvider` is specified and the connection is started:
     * 1. The connection is attempted with any existing access token from the `authProvider`.
     * 2. If the access token has expired, the `authProvider` is used to refresh the token.
     * 3. If token refresh fails or no access token exists, and auth is required, `OAuthClientProvider.redirectToAuthorization` is called, and an `UnauthorizedError` will be thrown from `connect`/`start`.
     *
     * After the user has finished authorizing via their user agent, and is redirected back to the MCP client application, call `StreamableHTTPClientTransport.finishAuth` with the authorization code before retrying the connection.
     *
     * If an `authProvider` is not provided, and auth is required, an `UnauthorizedError` will be thrown.
     *
     * `UnauthorizedError` might also be thrown when sending any message over the transport, indicating that the session has expired, and needs to be re-authed and reconnected.
     */
    authProvider?: OAuthClientProvider;

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
     * Session ID for the connection. This is used to identify the session on the server.
     * When not provided and connecting to a server that supports session IDs, the server will generate a new session ID.
     */
    sessionId?: string;
};

/**
 * Client transport for Streamable HTTP: this implements the MCP Streamable HTTP transport specification.
 * It will connect to a server using HTTP POST for sending messages and HTTP GET with Server-Sent Events
 * for receiving messages.
 */
export class StreamableHTTPClientTransport implements Transport {
    private _abortController?: AbortController;
    private _url: URL;
    private _resourceMetadataUrl?: URL;
    private _scope?: string;
    private _requestInit?: RequestInit;
    private _authProvider?: OAuthClientProvider;
    private _fetch?: FetchLike;
    private _fetchWithInit: FetchLike;
    private _sessionId?: string;
    private _reconnectionOptions: StreamableHTTPReconnectionOptions;
    private _protocolVersion?: string;
    private _hasCompletedAuthFlow = false; // Circuit breaker: detect auth success followed by immediate 401
    private _lastUpscopingHeader?: string; // Track last upscoping header to prevent infinite upscoping.
    private _serverRetryMs?: number; // Server-provided retry delay from SSE retry field
    private _reconnectionTimeout?: ReturnType<typeof setTimeout>;

    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    constructor(url: URL, opts?: StreamableHTTPClientTransportOptions) {
        this._url = url;
        this._resourceMetadataUrl = undefined;
        this._scope = undefined;
        this._requestInit = opts?.requestInit;
        this._authProvider = opts?.authProvider;
        this._fetch = opts?.fetch;
        this._fetchWithInit = createFetchWithInit(opts?.fetch, opts?.requestInit);
        this._sessionId = opts?.sessionId;
        this._reconnectionOptions = opts?.reconnectionOptions ?? DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS;
    }

    private async _authThenStart(): Promise<void> {
        if (!this._authProvider) {
            throw new UnauthorizedError('No auth provider');
        }

        let result: AuthResult;
        try {
            result = await auth(this._authProvider, {
                serverUrl: this._url,
                resourceMetadataUrl: this._resourceMetadataUrl,
                scope: this._scope,
                fetchFn: this._fetchWithInit
            });
        } catch (error) {
            this.onerror?.(error as Error);
            throw error;
        }

        if (result !== 'AUTHORIZED') {
            throw new UnauthorizedError();
        }

        return await this._startOrAuthSse({ resumptionToken: undefined });
    }

    private async _commonHeaders(): Promise<Headers> {
        const headers: HeadersInit & Record<string, string> = {};
        if (this._authProvider) {
            const tokens = await this._authProvider.tokens();
            if (tokens) {
                headers['Authorization'] = `Bearer ${tokens.access_token}`;
            }
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

    private async _startOrAuthSse(options: StartSSEOptions): Promise<void> {
        const { resumptionToken } = options;

        try {
            // Try to open an initial SSE stream with GET to listen for server messages
            // This is optional according to the spec - server may not support it
            const headers = await this._commonHeaders();
            headers.set('Accept', 'text/event-stream');

            // Include Last-Event-ID header for resumable streams if provided
            if (resumptionToken) {
                headers.set('last-event-id', resumptionToken);
            }

            const response = await (this._fetch ?? fetch)(this._url, {
                method: 'GET',
                headers,
                signal: this._abortController?.signal
            });

            if (!response.ok) {
                await response.body?.cancel();

                if (response.status === 401 && this._authProvider) {
                    // Need to authenticate
                    return await this._authThenStart();
                }

                // 405 indicates that the server does not offer an SSE stream at GET endpoint
                // This is an expected case that should not trigger an error
                if (response.status === 405) {
                    return;
                }

                throw new StreamableHTTPError(response.status, `Failed to open SSE stream: ${response.statusText}`);
            }

            this._handleSseStream(response.body, options, true);
        } catch (error) {
            this.onerror?.(error as Error);
            throw error;
        }
    }

    /**
     * Calculates the next reconnection delay using  backoff algorithm
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

        // Schedule the reconnection
        this._reconnectionTimeout = setTimeout(() => {
            // Use the last event ID to resume where we left off
            this._startOrAuthSse(options).catch(error => {
                this.onerror?.(new Error(`Failed to reconnect SSE stream: ${error instanceof Error ? error.message : String(error)}`));
                // Schedule another attempt if this one failed, incrementing the attempt counter
                this._scheduleReconnection(options, attemptCount + 1);
            });
        }, delay);
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
                            if (isJSONRPCResultResponse(message)) {
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
        if (!this._authProvider) {
            throw new UnauthorizedError('No auth provider');
        }

        const result = await auth(this._authProvider, {
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
        if (this._reconnectionTimeout) {
            clearTimeout(this._reconnectionTimeout);
            this._reconnectionTimeout = undefined;
        }
        this._abortController?.abort();
        this.onclose?.();
    }

    async send(
        message: JSONRPCMessage | JSONRPCMessage[],
        options?: { resumptionToken?: string; onresumptiontoken?: (token: string) => void }
    ): Promise<void> {
        try {
            const { resumptionToken, onresumptiontoken } = options || {};

            if (resumptionToken) {
                // If we have at last event ID, we need to reconnect the SSE stream
                this._startOrAuthSse({ resumptionToken, replayMessageId: isJSONRPCRequest(message) ? message.id : undefined }).catch(err =>
                    this.onerror?.(err)
                );
                return;
            }

            const headers = await this._commonHeaders();
            headers.set('content-type', 'application/json');
            headers.set('accept', 'application/json, text/event-stream');

            const init = {
                ...this._requestInit,
                method: 'POST',
                headers,
                body: JSON.stringify(message),
                signal: this._abortController?.signal
            };

            const response = await (this._fetch ?? fetch)(this._url, init);

            // Handle session ID received during initialization
            const sessionId = response.headers.get('mcp-session-id');
            if (sessionId) {
                this._sessionId = sessionId;
            }

            if (!response.ok) {
                const text = await response.text().catch(() => null);

                if (response.status === 401 && this._authProvider) {
                    // Prevent infinite recursion when server returns 401 after successful auth
                    if (this._hasCompletedAuthFlow) {
                        throw new StreamableHTTPError(401, 'Server returned 401 after successful authentication');
                    }

                    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
                    this._resourceMetadataUrl = resourceMetadataUrl;
                    this._scope = scope;

                    const result = await auth(this._authProvider, {
                        serverUrl: this._url,
                        resourceMetadataUrl: this._resourceMetadataUrl,
                        scope: this._scope,
                        fetchFn: this._fetchWithInit
                    });
                    if (result !== 'AUTHORIZED') {
                        throw new UnauthorizedError();
                    }

                    // Mark that we completed auth flow
                    this._hasCompletedAuthFlow = true;
                    // Purposely _not_ awaited, so we don't call onerror twice
                    return this.send(message);
                }

                if (response.status === 403 && this._authProvider) {
                    const { resourceMetadataUrl, scope, error } = extractWWWAuthenticateParams(response);

                    if (error === 'insufficient_scope') {
                        const wwwAuthHeader = response.headers.get('WWW-Authenticate');

                        // Check if we've already tried upscoping with this header to prevent infinite loops.
                        if (this._lastUpscopingHeader === wwwAuthHeader) {
                            throw new StreamableHTTPError(403, 'Server returned 403 after trying upscoping');
                        }

                        if (scope) {
                            this._scope = scope;
                        }

                        if (resourceMetadataUrl) {
                            this._resourceMetadataUrl = resourceMetadataUrl;
                        }

                        // Mark that upscoping was tried.
                        this._lastUpscopingHeader = wwwAuthHeader ?? undefined;
                        const result = await auth(this._authProvider, {
                            serverUrl: this._url,
                            resourceMetadataUrl: this._resourceMetadataUrl,
                            scope: this._scope,
                            fetchFn: this._fetch
                        });

                        if (result !== 'AUTHORIZED') {
                            throw new UnauthorizedError();
                        }

                        return this.send(message);
                    }
                }

                throw new StreamableHTTPError(response.status, `Error POSTing to endpoint: ${text}`);
            }

            // Reset auth loop flag on successful response
            this._hasCompletedAuthFlow = false;
            this._lastUpscopingHeader = undefined;

            // If the response is 202 Accepted, there's no body to process
            if (response.status === 202) {
                await response.body?.cancel();
                // if the accepted notification is initialized, we start the SSE stream
                // if it's supported by the server
                if (isInitializedNotification(message)) {
                    // Start without a lastEventId since this is a fresh connection
                    this._startOrAuthSse({ resumptionToken: undefined }).catch(err => this.onerror?.(err));
                }
                return;
            }

            // Get original message(s) for detecting request IDs
            const messages = Array.isArray(message) ? message : [message];

            const hasRequests = messages.filter(msg => 'method' in msg && 'id' in msg && msg.id !== undefined).length > 0;

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
                    await response.body?.cancel();
                    throw new StreamableHTTPError(-1, `Unexpected content type: ${contentType}`);
                }
            } else {
                // No requests in message but got 200 OK - still need to release connection
                await response.body?.cancel();
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
     * Terminates the current session by sending a DELETE request to the server.
     *
     * Clients that no longer need a particular session
     * (e.g., because the user is leaving the client application) SHOULD send an
     * HTTP DELETE to the MCP endpoint with the Mcp-Session-Id header to explicitly
     * terminate the session.
     *
     * The server MAY respond with HTTP 405 Method Not Allowed, indicating that
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
            await response.body?.cancel();

            // We specifically handle 405 as a valid response according to the spec,
            // meaning the server does not support explicit session termination
            if (!response.ok && response.status !== 405) {
                throw new StreamableHTTPError(response.status, `Failed to terminate session: ${response.statusText}`);
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
     * Opens a GET SSE connection with Last-Event-ID header to replay missed events.
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
