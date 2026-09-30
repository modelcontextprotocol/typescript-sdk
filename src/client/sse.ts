import { EventSource, type ErrorEvent, type EventSourceInit } from 'eventsource';
import {
    Transport,
    FetchLike,
    createFetchWithInit,
    fetchLeavingRedirects,
    fetchWithinOrigin,
    normalizeHeaders,
    unfollowedRedirect
} from '../shared/transport.js';
import { JSONRPCMessage, JSONRPCMessageSchema } from '../types.js';
import { auth, AuthResult, extractWWWAuthenticateParams, OAuthClientProvider, UnauthorizedError } from './auth.js';

export class SseError extends Error {
    constructor(
        public readonly code: number | undefined,
        message: string | undefined,
        public readonly event: ErrorEvent
    ) {
        super(`SSE error: ${message}`);
    }
}

/**
 * Configuration options for the `SSEClientTransport`.
 */
export type SSEClientTransportOptions = {
    /**
     * An OAuth client provider to use for authentication.
     *
     * When an `authProvider` is specified and the SSE connection is started:
     * 1. The connection is attempted with any existing access token from the `authProvider`.
     * 2. If the access token has expired, the `authProvider` is used to refresh the token.
     * 3. If token refresh fails or no access token exists, and auth is required, `OAuthClientProvider.redirectToAuthorization` is called, and an `UnauthorizedError` will be thrown from `connect`/`start`.
     *
     * After the user has finished authorizing via their user agent, and is redirected back to the MCP client application, call `SSEClientTransport.finishAuth` with the authorization code before retrying the connection.
     *
     * If an `authProvider` is not provided, and auth is required, an `UnauthorizedError` will be thrown.
     *
     * `UnauthorizedError` might also be thrown when sending any message over the SSE transport, indicating that the session has expired, and needs to be re-authed and reconnected.
     */
    authProvider?: OAuthClientProvider;

    /**
     * Customizes the initial SSE request to the server (the request that begins the stream).
     *
     * NOTE: Setting this property will prevent an `Authorization` header from
     * being automatically attached to the SSE request, if an `authProvider` is
     * also given. This can be worked around by setting the `Authorization` header
     * manually.
     */
    eventSourceInit?: EventSourceInit;

    /**
     * Customizes recurring POST requests to the server.
     */
    requestInit?: RequestInit;

    /**
     * Custom fetch implementation used for all network requests.
     */
    fetch?: FetchLike;

    /**
     * How a redirect of one of the transport's requests is handled, including the OAuth requests it makes for `authProvider`.
     *
     * - `'same-origin'` (default): a redirect is followed only when it keeps the method and stays within the origin of the request, or goes from http to https on the same host with default ports; any other redirect is not followed and the request fails.
     * - `'follow'`: redirects are left to the fetch implementation, as in earlier versions of the SDK.
     *
     * With either value, a `requestInit.redirect` of `'error'` or `'manual'` is passed to fetch unchanged for the POST requests that carry messages.
     * The OAuth requests read `requestInit.redirect` only with `'follow'`, and the request that opens the stream does not read it.
     */
    redirectPolicy?: 'same-origin' | 'follow';
};

/**
 * Client transport for SSE: this will connect to a server using Server-Sent Events for receiving
 * messages and make separate POST requests for sending messages.
 * @deprecated SSEClientTransport is deprecated. Prefer to use StreamableHTTPClientTransport where possible instead. Note that because some servers are still using SSE, clients may need to support both transports during the migration period.
 */
export class SSEClientTransport implements Transport {
    private _eventSource?: EventSource;
    private _endpoint?: URL;
    private _abortController?: AbortController;
    private _url: URL;
    private _resourceMetadataUrl?: URL;
    private _scope?: string;
    private _eventSourceInit?: EventSourceInit;
    private _requestInit?: RequestInit;
    private _authProvider?: OAuthClientProvider;
    private _fetch?: FetchLike;
    private _fetchWithInit: FetchLike;
    private _followRedirects: boolean;
    private _protocolVersion?: string;

    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    constructor(url: URL, opts?: SSEClientTransportOptions) {
        this._url = url;
        this._resourceMetadataUrl = undefined;
        this._scope = undefined;
        this._eventSourceInit = opts?.eventSourceInit;
        this._requestInit = opts?.requestInit;
        this._authProvider = opts?.authProvider;
        this._fetch = opts?.fetch;
        this._fetchWithInit = createFetchWithInit(opts?.fetch, opts?.requestInit);
        this._followRedirects = opts?.redirectPolicy === 'follow';
        if (this._followRedirects) {
            this._fetch = fetchLeavingRedirects(this._fetch);
            this._fetchWithInit = fetchLeavingRedirects(this._fetchWithInit);
        }
    }

    /** Error text for a redirect `response` that was not followed, or `undefined` for any other response. */
    private _unfollowedRedirect(response: Response, url: string | URL): string | undefined {
        const text = unfollowedRedirect(response, url);
        return text && !this._followRedirects ? `${text} (redirectPolicy: 'same-origin')` : text;
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

        return await this._startOrAuth();
    }

    private async _commonHeaders(): Promise<Headers> {
        const headers: HeadersInit & Record<string, string> = {};
        if (this._authProvider) {
            const tokens = await this._authProvider.tokens();
            if (tokens) {
                headers['Authorization'] = `Bearer ${tokens.access_token}`;
            }
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

    private _startOrAuth(): Promise<void> {
        const baseFetch = (this?._eventSourceInit?.fetch ?? this._fetch ?? fetch) as typeof fetch;
        const fetchImpl = this._followRedirects ? baseFetch : fetchWithinOrigin(baseFetch);
        let redirect: string | undefined;
        return new Promise((resolve, reject) => {
            this._eventSource = new EventSource(this._url.href, {
                ...this._eventSourceInit,
                fetch: async (url, init) => {
                    const headers = await this._commonHeaders();
                    headers.set('Accept', 'text/event-stream');
                    const response = await fetchImpl(url, {
                        ...init,
                        headers
                    });
                    redirect = this._unfollowedRedirect(response, url);

                    if (response.status === 401 && response.headers.has('www-authenticate')) {
                        const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
                        this._resourceMetadataUrl = resourceMetadataUrl;
                        this._scope = scope;
                    }

                    return response;
                }
            });
            this._abortController = new AbortController();

            this._eventSource.onerror = event => {
                if (event.code === 401 && this._authProvider) {
                    this._authThenStart().then(resolve, reject);
                    return;
                }

                const error = new SseError(event.code, redirect ?? event.message, event);
                reject(error);
                this.onerror?.(error);
            };

            this._eventSource.onopen = () => {
                // The connection is open, but we need to wait for the endpoint to be received.
            };

            this._eventSource.addEventListener('endpoint', (event: Event) => {
                const messageEvent = event as MessageEvent;

                try {
                    this._endpoint = new URL(messageEvent.data, this._url);
                    if (this._endpoint.origin !== this._url.origin) {
                        throw new Error(`Endpoint origin does not match connection origin: ${this._endpoint.origin}`);
                    }
                } catch (error) {
                    reject(error);
                    this.onerror?.(error as Error);

                    void this.close();
                    return;
                }

                resolve();
            });

            this._eventSource.onmessage = (event: Event) => {
                const messageEvent = event as MessageEvent;
                let message: JSONRPCMessage;
                try {
                    message = JSONRPCMessageSchema.parse(JSON.parse(messageEvent.data));
                } catch (error) {
                    this.onerror?.(error as Error);
                    return;
                }

                this.onmessage?.(message);
            };
        });
    }

    async start() {
        if (this._eventSource) {
            throw new Error('SSEClientTransport already started! If using Client class, note that connect() calls start() automatically.');
        }

        return await this._startOrAuth();
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
        this._abortController?.abort();
        this._eventSource?.close();
        this.onclose?.();
    }

    async send(message: JSONRPCMessage): Promise<void> {
        if (!this._endpoint) {
            throw new Error('Not connected');
        }

        try {
            const headers = await this._commonHeaders();
            headers.set('content-type', 'application/json');
            const init = {
                ...this._requestInit,
                method: 'POST',
                headers,
                body: JSON.stringify(message),
                signal: this._abortController?.signal
            };

            const response = await fetchWithinOrigin(this._fetch ?? fetch)(this._endpoint, init);
            if (!response.ok) {
                const text = await response.text().catch(() => null);

                if (response.status === 401 && this._authProvider) {
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

                    // Purposely _not_ awaited, so we don't call onerror twice
                    return this.send(message);
                }

                throw new Error(
                    `Error POSTing to endpoint (HTTP ${response.status}): ${this._unfollowedRedirect(response, this._endpoint) ?? text}`
                );
            }

            // Release connection - POST responses don't have content we need
            await response.body?.cancel();
        } catch (error) {
            this.onerror?.(error as Error);
            throw error;
        }
    }

    setProtocolVersion(version: string): void {
        this._protocolVersion = version;
    }
}
