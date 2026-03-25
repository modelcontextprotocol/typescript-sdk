import type { FetchLike, JSONRPCMessage, Transport } from '@modelcontextprotocol/core';
import { createFetchWithInit, JSONRPCMessageSchema, normalizeHeaders, SdkError, SdkErrorCode } from '@modelcontextprotocol/core';
import type { ErrorEvent, EventSourceInit } from 'eventsource';
import { EventSource } from 'eventsource';

import type { AuthProvider, OAuthClientProvider } from './auth.js';
import { adaptOAuthProvider, auth, extractWWWAuthenticateParams, isOAuthClientProvider, UnauthorizedError } from './auth.js';

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
 * Configuration options for the {@linkcode SSEClientTransport}.
 */
export type SSEClientTransportOptions = {
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
     * For OAuth flows, pass an {@linkcode index.OAuthClientProvider | OAuthClientProvider} implementation.
     * Interactive flows: after {@linkcode UnauthorizedError}, redirect the user, then call
     * {@linkcode SSEClientTransport.finishAuth | finishAuth} with the authorization code before reconnecting.
     */
    authProvider?: AuthProvider | OAuthClientProvider;

    /**
     * Customizes the initial SSE request to the server (the request that begins the stream).
     *
     * NOTE: Setting this property will prevent an `Authorization` header from
     * being automatically attached to the SSE request, if an {@linkcode SSEClientTransportOptions.authProvider | authProvider} is
     * also given. This can be worked around by setting the `Authorization` header
     * manually.
     */
    eventSourceInit?: EventSourceInit;

    /**
     * Customizes recurring `POST` requests to the server.
     */
    requestInit?: RequestInit;

    /**
     * Custom fetch implementation used for all network requests.
     */
    fetch?: FetchLike;
};

/**
 * Client transport for SSE: this will connect to a server using Server-Sent Events for receiving
 * messages and make separate `POST` requests for sending messages.
 * @deprecated SSEClientTransport is deprecated. Prefer to use {@linkcode index.StreamableHTTPClientTransport | StreamableHTTPClientTransport} where possible instead. Note that because some servers are still using SSE, clients may need to support both transports during the migration period.
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
    private _authProvider?: AuthProvider;
    private _oauthProvider?: OAuthClientProvider;
    private _fetch?: FetchLike;
    private _fetchWithInit: FetchLike;
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
        if (isOAuthClientProvider(opts?.authProvider)) {
            this._oauthProvider = opts.authProvider;
            this._authProvider = adaptOAuthProvider(opts.authProvider);
        } else {
            this._authProvider = opts?.authProvider;
        }
        this._fetch = opts?.fetch;
        this._fetchWithInit = createFetchWithInit(opts?.fetch, opts?.requestInit);
    }

    private _last401Response?: Response;

    private async _commonHeaders(): Promise<Headers> {
        const headers: RequestInit['headers'] & Record<string, string> = {};
        const token = await this._authProvider?.token();
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
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
        const fetchImpl = (this?._eventSourceInit?.fetch ?? this._fetch ?? fetch) as typeof fetch;
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

                    if (response.status === 401) {
                        this._last401Response = response;
                        if (response.headers.has('www-authenticate')) {
                            const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
                            this._resourceMetadataUrl = resourceMetadataUrl;
                            this._scope = scope;
                        }
                    }

                    return response;
                }
            });
            this._abortController = new AbortController();

            this._eventSource.onerror = event => {
                if (event.code === 401 && this._authProvider) {
                    if (this._authProvider.onUnauthorized && this._last401Response) {
                        const response = this._last401Response;
                        this._last401Response = undefined;
                        this._eventSource?.close();
                        this._authProvider.onUnauthorized({ response, serverUrl: this._url, fetchFn: this._fetchWithInit }).then(
                            // onUnauthorized succeeded → retry fresh. Its onerror handles its own onerror?.() + reject.
                            () => this._startOrAuth().then(resolve, reject),
                            // onUnauthorized failed → not yet reported.
                            error => {
                                this.onerror?.(error);
                                reject(error);
                            }
                        );
                        return;
                    }
                    const error = new UnauthorizedError();
                    reject(error);
                    this.onerror?.(error);
                    return;
                }

                const error = new SseError(event.code, event.message, event);
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
        this._abortController?.abort();
        this._eventSource?.close();
        this.onclose?.();
    }

    async send(message: JSONRPCMessage): Promise<void> {
        return this._send(message, false);
    }

    private async _send(message: JSONRPCMessage, isAuthRetry: boolean): Promise<void> {
        if (!this._endpoint) {
            throw new SdkError(SdkErrorCode.NotConnected, 'Not connected');
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

            const response = await (this._fetch ?? fetch)(this._endpoint, init);
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
                        return this._send(message, true);
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
                throw new Error(`Error POSTing to endpoint (HTTP ${response.status}): ${text}`);
            }

            // Release connection - POST responses don't have content we need
            await response.text?.().catch(() => {});
        } catch (error) {
            this.onerror?.(error as Error);
            throw error;
        }
    }

    setProtocolVersion(version: string): void {
        this._protocolVersion = version;
    }
}
