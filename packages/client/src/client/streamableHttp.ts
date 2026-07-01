import type { ReadableWritablePair } from 'node:stream/web';

import type { FetchLike, JSONRPCMessage, Transport } from '@modelcontextprotocol/core-internal';
import {
    createFetchWithInit,
    encodeMcpParamValue,
    isInitializedNotification,
    isJSONRPCErrorResponse,
    isJSONRPCRequest,
    isJSONRPCResultResponse,
    isModernProtocolVersion,
    JSONRPCMessageSchema,
    normalizeHeaders,
    PROTOCOL_VERSION_META_KEY,
    SdkError,
    SdkErrorCode,
    SdkHttpError
} from '@modelcontextprotocol/core-internal';
import { EventSourceParserStream } from 'eventsource-parser/stream';

import type { AuthProvider, OAuthClientProvider } from './auth';
import {
    adaptOAuthProvider,
    auth,
    computeScopeUnion,
    extractWWWAuthenticateParams,
    isOAuthClientProvider,
    isStrictScopeSuperset,
    resolveAuthorizationCallbackParams,
    UnauthorizedError
} from './auth';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- referenced via {@linkcode} in finishAuth JSDoc
import type { IssuerMismatchError } from './authErrors';
import { InsufficientScopeError } from './authErrors';

/** Default cap on step-up re-authorization retries within a single send/stream-open. */
const DEFAULT_MAX_STEP_UP_RETRIES = 1;

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

    /**
     * The per-request abort signal supplied by the caller via
     * `TransportSendOptions.requestSignal`. When this signal is aborted the
     * originating POST and its SSE response stream are torn down
     * intentionally — `_handleSseStream` treats it exactly like the
     * transport-level abort: no `onerror`, no reconnect.
     */
    requestSignal?: AbortSignal;

    /**
     * The per-request stream-end callback supplied via
     * `TransportSendOptions.onRequestStreamEnd`. Fired when the SSE response
     * stream for the originating POST ends or errors for any non-deliberate
     * reason (server closed, network dropped, reconnection exhausted) — never
     * when `requestSignal` was aborted.
     */
    onRequestStreamEnd?: () => void;
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
     * Opt-out for the RFC 8414 §3.3 issuer-echo check during authorization-server
     * metadata discovery. **Security-weakening** — see
     * {@linkcode index.AuthOptions.skipIssuerMetadataValidation | AuthOptions.skipIssuerMetadataValidation}.
     * Only honoured when {@linkcode StreamableHTTPClientTransportOptions.authProvider | authProvider}
     * is an `OAuthClientProvider`.
     */
    skipIssuerMetadataValidation?: boolean;

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

    /**
     * How the transport reacts to a `403 Forbidden` response carrying
     * `WWW-Authenticate: Bearer error="insufficient_scope"`.
     *
     * - `'reauthorize'` (default): the transport runs the step-up authorization
     *   flow — computes the union of the previously-requested scope and the
     *   challenged scope, calls {@linkcode index.auth | auth()} (forcing a
     *   fresh authorization request when the union strictly exceeds the current
     *   token's granted scope, since refresh cannot widen scope per RFC 6749
     *   §6), and retries the request once. Retries are bounded by
     *   {@linkcode StreamableHTTPClientTransportOptions.maxStepUpRetries | maxStepUpRetries}.
     *   If no {@linkcode index.OAuthClientProvider | OAuthClientProvider} is
     *   configured, step-up cannot run and the transport throws
     *   {@linkcode index.InsufficientScopeError | InsufficientScopeError} instead.
     * - `'throw'`: the transport throws {@linkcode index.InsufficientScopeError | InsufficientScopeError}
     *   carrying the challenge parameters and does not re-authorize. Use this
     *   for `client_credentials` / m2m clients where re-authorization cannot
     *   widen scope, or for interactive clients that want to gate the consent
     *   prompt behind UX.
     *
     * @default 'reauthorize'
     */
    onInsufficientScope?: 'reauthorize' | 'throw';

    /**
     * Maximum number of step-up re-authorization attempts the transport makes
     * per send (and per GET stream open) before giving up. Only consulted when
     * {@linkcode StreamableHTTPClientTransportOptions.onInsufficientScope | onInsufficientScope}
     * is `'reauthorize'`. Cross-request tracking ("this resource+operation
     * already failed N times across the session") is host responsibility.
     *
     * @default 1
     */
    maxStepUpRetries?: number;
};

function setMcpStandardPostHeaders(headers: Headers, message: JSONRPCMessage | JSONRPCMessage[]): void {
    if (Array.isArray(message) || !('method' in message) || typeof message.method !== 'string') {
        return;
    }

    headers.set('Mcp-Method', message.method);

    const params = 'params' in message ? message.params : undefined;
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
        return;
    }

    const requestParams = params as { name?: unknown; uri?: unknown };
    const mcpName = typeof requestParams.name === 'string' ? requestParams.name : requestParams.uri;
    if (typeof mcpName === 'string') {
        headers.set('Mcp-Name', mcpName);
    }
}

/**
 * Standard/auth header names the transport owns. The per-request
 * `TransportSendOptions.headers` carrier MUST NOT be able to override these —
 * they are derived from connection state (`authorization`, `mcp-session-id`)
 * or from the message body itself (`mcp-protocol-version`, `mcp-method`,
 * `mcp-name`), and a per-request override would let a caller produce a
 * header/body disagreement the server's SEP-2243 cross-checks reject.
 */
const RESERVED_REQUEST_HEADER_NAMES: ReadonlySet<string> = new Set([
    'authorization',
    'content-type',
    'mcp-protocol-version',
    'mcp-method',
    'mcp-name',
    'mcp-session-id'
]);

/**
 * `AbortSignal.any` with a manual fallback. `AbortSignal.any` landed in
 * Node 20.3; this package's `engines` floor is `>=20`, so 20.0–20.2 must be
 * served by the fallback combinator (a controller that aborts on the first
 * of `a` or `b`). The native path is preferred because it propagates the
 * originating signal's `reason` and participates in GC the way the spec
 * defines.
 */
function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
    if (typeof AbortSignal.any === 'function') {
        return AbortSignal.any([a, b]);
    }
    const controller = new AbortController();
    if (a.aborted) return (controller.abort(a.reason), controller.signal);
    if (b.aborted) return (controller.abort(b.reason), controller.signal);
    // Standard polyfill shape: when EITHER input fires, remove the listener
    // registered on the OTHER input too. `{once:true}` alone leaks the
    // sibling listener — for `_send()`, `a` is the transport-lifetime signal,
    // so every request-scoped `b` that aborts would otherwise leave one
    // listener + closure pinned on `a` for the life of the transport.
    const cleanup = (): void => {
        a.removeEventListener('abort', onA);
        b.removeEventListener('abort', onB);
    };
    function onA(): void {
        cleanup();
        controller.abort(a.reason);
    }
    function onB(): void {
        cleanup();
        controller.abort(b.reason);
    }
    a.addEventListener('abort', onA, { once: true });
    b.addEventListener('abort', onB, { once: true });
    return controller.signal;
}

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
    private _skipIssuerMetadataValidation?: boolean;
    private _fetch?: FetchLike;
    private _fetchWithInit: FetchLike;
    private _sessionId?: string;
    private _reconnectionOptions: StreamableHTTPReconnectionOptions;
    private _protocolVersion?: string;
    private _onInsufficientScope: 'reauthorize' | 'throw';
    private _maxStepUpRetries: number;
    private _serverRetryMs?: number; // Server-provided retry delay from SSE retry field
    private readonly _reconnectionScheduler?: ReconnectionScheduler;
    private _cancelReconnection?: () => void;

    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    /**
     * Streamable HTTP opens one POST (and SSE response stream) per outbound
     * request and honors `TransportSendOptions.requestSignal`. On a 2026-era
     * connection the protocol layer aborts that per-request stream as the
     * spec cancellation signal instead of POSTing `notifications/cancelled`.
     */
    readonly hasPerRequestStream = true;

    constructor(url: URL, opts?: StreamableHTTPClientTransportOptions) {
        this._url = url;
        this._resourceMetadataUrl = undefined;
        this._scope = undefined;
        this._requestInit = opts?.requestInit;
        this._skipIssuerMetadataValidation = opts?.skipIssuerMetadataValidation;
        if (isOAuthClientProvider(opts?.authProvider)) {
            this._oauthProvider = opts.authProvider;
            this._authProvider = adaptOAuthProvider(opts.authProvider, {
                skipIssuerMetadataValidation: opts.skipIssuerMetadataValidation
            });
        } else {
            this._authProvider = opts?.authProvider;
        }
        this._fetch = opts?.fetch;
        this._fetchWithInit = createFetchWithInit(opts?.fetch, opts?.requestInit);
        this._sessionId = opts?.sessionId;
        this._protocolVersion = opts?.protocolVersion;
        this._reconnectionOptions = opts?.reconnectionOptions ?? DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS;
        this._reconnectionScheduler = opts?.reconnectionScheduler;
        this._onInsufficientScope = opts?.onInsufficientScope ?? 'reauthorize';
        this._maxStepUpRetries = Math.max(0, opts?.maxStepUpRetries ?? DEFAULT_MAX_STEP_UP_RETRIES);
    }

    /**
     * SEP-2350 step-up: compute the union scope, decide whether refresh must be
     * bypassed, and run {@linkcode auth}. Returns the auth result so the caller
     * can decide whether to retry. Shared by the POST `_send` path and the GET
     * `_startOrAuthSse` path so both apply the same `'throw'` short-circuit,
     * the same superset-gated refresh bypass, and the same retry cap.
     */
    private async _stepUpAuthorize(
        challenge: { scope?: string; resourceMetadataUrl?: URL; errorDescription?: string; statusText?: string; text?: string | null },
        stepUpRetries: number
    ): Promise<'AUTHORIZED' | 'REDIRECT'> {
        if (this._onInsufficientScope === 'throw') {
            throw new InsufficientScopeError({
                requiredScope: challenge.scope,
                resourceMetadataUrl: challenge.resourceMetadataUrl,
                errorDescription: challenge.errorDescription
            });
        }
        if (!this._oauthProvider) {
            // No OAuth provider to drive step-up; surface the typed error so the
            // host can act on it.
            throw new InsufficientScopeError({
                requiredScope: challenge.scope,
                resourceMetadataUrl: challenge.resourceMetadataUrl,
                errorDescription: challenge.errorDescription
            });
        }
        if (stepUpRetries >= this._maxStepUpRetries) {
            throw new SdkHttpError(
                SdkErrorCode.ClientHttpForbidden,
                `Server returned 403 insufficient_scope after step-up re-authorization (retry limit ${this._maxStepUpRetries} reached)`,
                { status: 403, statusText: challenge.statusText ?? 'Forbidden', text: challenge.text }
            );
        }

        if (challenge.resourceMetadataUrl) {
            this._resourceMetadataUrl = challenge.resourceMetadataUrl;
        }

        // Spec step-up: union of previously-requested scope and challenged scope,
        // so previously-granted permissions are not lost on re-authorization.
        const tokens = await this._oauthProvider.tokens();
        const unionScope = computeScopeUnion(this._scope, tokens?.scope, challenge.scope);
        this._scope = unionScope;

        // Superset-gated refresh bypass: refresh cannot widen scope (RFC 6749 §6),
        // so when the union strictly exceeds what the current token was granted
        // we must force a fresh authorization request.
        const forceReauthorization = isStrictScopeSuperset(unionScope, tokens?.scope);

        return auth(this._oauthProvider, {
            serverUrl: this._url,
            resourceMetadataUrl: this._resourceMetadataUrl,
            scope: unionScope,
            forceReauthorization,
            fetchFn: this._fetchWithInit,
            skipIssuerMetadataValidation: this._skipIssuerMetadataValidation
        });
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
     * Body-derived per-request headers: when an outgoing request carries a
     * protocol-version claim in its `_meta` envelope (the version negotiation
     * probe is the first such sender), `MCP-Protocol-Version` and `Mcp-Method`
     * derive from the message itself. The connection-level version slot is
     * neither consulted nor mutated; messages without an envelope claim are
     * untouched, so no 2026 header can appear on a legacy exchange.
     */
    private _applyBodyDerivedHeaders(headers: Headers, message: JSONRPCMessage | JSONRPCMessage[]): void {
        if (Array.isArray(message) || !isJSONRPCRequest(message)) {
            return;
        }
        const meta = (message.params as { _meta?: Record<string, unknown> } | undefined)?._meta;
        const envelopeVersion = meta?.[PROTOCOL_VERSION_META_KEY];
        if (typeof envelopeVersion !== 'string') {
            return;
        }
        headers.set('mcp-protocol-version', envelopeVersion);
        headers.set('mcp-method', message.method);
        // SEP-2243 standard headers, step 2 of the 5-step client algorithm:
        // Mcp-Name mirrors `params.name` (tools/call, prompts/get) or
        // `params.uri` (resources/read). The value is run through the same
        // `=?base64?…?=` sentinel encoding the `Mcp-Param-*` codec uses so a
        // non-ASCII name/URI (or one with leading/trailing whitespace,
        // control characters, or CR/LF) cannot make `Headers.set()` throw a
        // TypeError or silently normalize to a value that differs from the
        // body. The spec's value-encoding rules apply to `Mcp-Name`; the SDK
        // server's `validateStandardRequestHeaders` decodes the sentinel via
        // `decodeMcpParamValue` before the `Mcp-Name` ↔ body cross-check.
        const params = message.params as { name?: unknown; uri?: unknown } | undefined;
        const nameHeader =
            message.method === 'resources/read'
                ? typeof params?.uri === 'string'
                    ? params.uri
                    : undefined
                : typeof params?.name === 'string'
                  ? params.name
                  : undefined;
        if (nameHeader !== undefined) {
            headers.set('mcp-name', encodeMcpParamValue(nameHeader));
        }
    }

    /**
     * `true` when the outbound message is a single request carrying a
     * modern-era protocol-version envelope claim — the same predicate that
     * gates body-derived `mcp-method`/`mcp-name` emission. Used to confine the
     * 400-body-as-ProtocolError delivery to modern-era exchanges only.
     */
    private _isModernEnvelopedRequest(message: JSONRPCMessage | JSONRPCMessage[]): boolean {
        if (Array.isArray(message) || !isJSONRPCRequest(message)) return false;
        const meta = (message.params as { _meta?: Record<string, unknown> } | undefined)?._meta;
        const v = meta?.[PROTOCOL_VERSION_META_KEY];
        return typeof v === 'string' && isModernProtocolVersion(v);
    }

    private async _startOrAuthSse(options: StartSSEOptions, isAuthRetry = false, stepUpRetries = 0): Promise<void> {
        const { resumptionToken, requestSignal } = options;
        // Same guard as `_handleSseStream`: a resurrected listen stream (the
        // POST-SSE → GET reconnect path threads `requestSignal` through
        // `StartSSEOptions`) must honour the per-request abort exactly as the
        // original POST did — both as a fetch signal and as a "do not surface
        // onerror" gate.
        const isIntentionalAbort = (): boolean => this._abortController?.signal.aborted === true || requestSignal?.aborted === true;

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

            const transportSignal = this._abortController?.signal;
            const signal =
                requestSignal !== undefined && transportSignal !== undefined
                    ? anySignal(transportSignal, requestSignal)
                    : (requestSignal ?? transportSignal);
            const response = await (this._fetch ?? fetch)(this._url, {
                ...this._requestInit,
                method: 'GET',
                headers,
                signal
            });

            if (!response.ok) {
                if (response.status === 401 && this._authProvider) {
                    if (response.headers.has('www-authenticate')) {
                        const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
                        this._resourceMetadataUrl = resourceMetadataUrl;
                        // Preserve any union accumulated by `_stepUpAuthorize` so a 401
                        // mid-chain does not narrow `_scope` back to the challenge value.
                        this._scope = computeScopeUnion(this._scope, scope);
                    }

                    if (this._authProvider.onUnauthorized && !isAuthRetry) {
                        await this._authProvider.onUnauthorized({
                            response,
                            serverUrl: this._url,
                            fetchFn: this._fetchWithInit
                        });
                        await response.text?.().catch(() => {});
                        // Purposely _not_ awaited, so we don't call onerror twice
                        return this._startOrAuthSse(options, true, stepUpRetries);
                    }
                    await response.text?.().catch(() => {});
                    if (isAuthRetry) {
                        throw new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, 'Server returned 401 after re-authentication', {
                            status: 401,
                            statusText: response.statusText
                        });
                    }
                    throw new UnauthorizedError();
                }

                if (response.status === 403) {
                    const { resourceMetadataUrl, scope, error, errorDescription } = extractWWWAuthenticateParams(response);
                    if (error === 'insufficient_scope') {
                        const text = await response.text?.().catch(() => null);
                        const result = await this._stepUpAuthorize(
                            { scope, resourceMetadataUrl, errorDescription, statusText: response.statusText, text },
                            stepUpRetries
                        );
                        if (result !== 'AUTHORIZED') {
                            throw new UnauthorizedError();
                        }
                        return this._startOrAuthSse(options, isAuthRetry, stepUpRetries + 1);
                    }
                }

                await response.text?.().catch(() => {});

                // 405 indicates that the server does not offer an SSE stream at GET endpoint
                // This is an expected case that should not trigger an error
                if (response.status === 405) {
                    // A 405 on the standalone-GET path is benign (the caller
                    // never had a per-request stream). On the POST→GET resume
                    // path it is a TERMINAL non-resumable outcome for a
                    // per-request stream the caller is observing — fire the
                    // stream-end callback so the caller can settle (otherwise
                    // a resumed listen subscription dead-ends silently). The
                    // standalone-GET callers never pass `onRequestStreamEnd`,
                    // so this is a no-op for them.
                    options.onRequestStreamEnd?.();
                    return;
                }

                throw new SdkHttpError(SdkErrorCode.ClientHttpFailedToOpenStream, `Failed to open SSE stream: ${response.statusText}`, {
                    status: response.status,
                    statusText: response.statusText
                });
            }

            this._handleSseStream(response.body, options, true);
        } catch (error) {
            if (!isIntentionalAbort()) {
                this.onerror?.(error as Error);
            }
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
            // The per-request stream is now definitively gone.
            options.onRequestStreamEnd?.();
            return;
        }

        // Calculate next delay based on current attempt count
        const delay = this._getNextReconnectionDelay(attemptCount);

        const reconnect = (): void => {
            this._cancelReconnection = undefined;
            // Honour BOTH the transport-wide abort and the per-request abort
            // (a listen subscription closed during the backoff delay): do not
            // resurrect a stream the caller already tore down.
            if (this._abortController?.signal.aborted || options.requestSignal?.aborted) return;
            this._startOrAuthSse(options).catch(error => {
                if (this._abortController?.signal.aborted || options.requestSignal?.aborted) return;
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
            // A null body on a per-request stream (or its GET resume) is the
            // same terminal non-resumable outcome as a 405 — fire the
            // stream-end callback so the caller can settle. No-op for
            // standalone-GET callers (they never pass `onRequestStreamEnd`).
            options.onRequestStreamEnd?.();
            return;
        }
        const { onresumptiontoken, replayMessageId, requestSignal, onRequestStreamEnd } = options;
        // An intentional abort — transport-wide close OR a per-request abort
        // (McpSubscription.close() aborting its `requestSignal`) — must read as
        // a clean shutdown: no misleading "SSE stream disconnected" onerror,
        // and no GET+Last-Event-ID reconnect that would resurrect a stream the
        // caller just tore down.
        const isIntentionalAbort = (): boolean => this._abortController?.signal.aborted === true || requestSignal?.aborted === true;

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
                if (needsReconnect && this._abortController && !isIntentionalAbort()) {
                    this._scheduleReconnection(
                        {
                            resumptionToken: lastEventId,
                            onresumptiontoken,
                            replayMessageId,
                            requestSignal,
                            onRequestStreamEnd
                        },
                        0
                    );
                } else if (!isIntentionalAbort()) {
                    // The per-request stream ended without reconnecting (no
                    // priming event for a POST stream, or response already
                    // received). Not a deliberate abort — notify the caller.
                    onRequestStreamEnd?.();
                }
            } catch (error) {
                if (isIntentionalAbort()) {
                    // The reader threw because we aborted it. Not an error; do
                    // not surface onerror, do not reconnect.
                    return;
                }
                // Handle stream errors - likely a network disconnect
                this.onerror?.(new Error(`SSE stream disconnected: ${error}`));

                // Attempt to reconnect if the stream disconnects unexpectedly and we aren't closing
                // Reconnect if: already reconnectable (GET stream) OR received a priming event (POST stream with event ID)
                // BUT don't reconnect if we already received a response - the request is complete
                const canResume = isReconnectable || hasPrimingEvent;
                const needsReconnect = canResume && !receivedResponse;
                if (needsReconnect && this._abortController && !isIntentionalAbort()) {
                    // Use the exponential backoff reconnection strategy
                    try {
                        this._scheduleReconnection(
                            {
                                resumptionToken: lastEventId,
                                onresumptiontoken,
                                replayMessageId,
                                requestSignal,
                                onRequestStreamEnd
                            },
                            0
                        );
                    } catch (error) {
                        this.onerror?.(new Error(`Failed to reconnect: ${error instanceof Error ? error.message : String(error)}`));
                        onRequestStreamEnd?.();
                    }
                } else {
                    // Non-deliberate stream error without reconnection: the
                    // per-request stream is gone — notify the caller.
                    onRequestStreamEnd?.();
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
     *
     * **Preferred:** pass the callback URL's `searchParams` directly. The SDK extracts `code`
     * and `iss`, validates `iss` against the recorded issuer (RFC 9207) **before** reading any
     * other parameter, and on mismatch throws an {@linkcode IssuerMismatchError} that carries
     * none of the callback's `error`/`error_description`/`error_uri` text — those are
     * attacker-controlled in a mix-up attack and MUST NOT be displayed. The `(code, iss?)`
     * positional form remains supported for back-compat.
     *
     * The SDK does **not** validate `state`; compare it to your stored value before calling
     * `finishAuth`.
     *
     * @param callbackParams - The `URLSearchParams` from the authorization callback URL
     *   (e.g. `new URL(callbackUrl).searchParams`). `code` and `iss` are read from it.
     */
    async finishAuth(callbackParams: URLSearchParams): Promise<void>;
    /**
     * @param authorizationCode - The `code` query parameter from the authorization callback URL.
     * @param iss - The form-urldecoded `iss` query parameter from the same callback URL, if
     *   present. Validated per RFC 9207 against the recorded issuer before the code is redeemed.
     *   When the authorization server advertises `authorization_response_iss_parameter_supported: true`,
     *   omitting this causes the exchange to be **rejected** with {@linkcode IssuerMismatchError}.
     */
    async finishAuth(authorizationCode: string, iss?: string): Promise<void>;
    async finishAuth(codeOrParams: string | URLSearchParams, iss?: string): Promise<void> {
        if (!this._oauthProvider) {
            throw new UnauthorizedError('finishAuth requires an OAuthClientProvider');
        }

        const { authorizationCode, iss: issParam } = await resolveAuthorizationCallbackParams(
            codeOrParams,
            iss,
            this._oauthProvider,
            this._url,
            { fetchFn: this._fetchWithInit, resourceMetadataUrl: this._resourceMetadataUrl }
        );

        const result = await auth(this._oauthProvider, {
            serverUrl: this._url,
            authorizationCode,
            iss: issParam,
            resourceMetadataUrl: this._resourceMetadataUrl,
            scope: this._scope,
            fetchFn: this._fetchWithInit,
            skipIssuerMetadataValidation: this._skipIssuerMetadataValidation
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
        options?: {
            resumptionToken?: string;
            onresumptiontoken?: (token: string) => void;
            requestSignal?: AbortSignal;
            onRequestStreamEnd?: () => void;
            headers?: Readonly<Record<string, string>>;
        }
    ): Promise<void> {
        return this._send(message, options, false);
    }

    private async _send(
        message: JSONRPCMessage | JSONRPCMessage[],
        options:
            | {
                  resumptionToken?: string;
                  onresumptiontoken?: (token: string) => void;
                  requestSignal?: AbortSignal;
                  onRequestStreamEnd?: () => void;
                  headers?: Readonly<Record<string, string>>;
              }
            | undefined,
        isAuthRetry: boolean,
        stepUpRetries = 0
    ): Promise<void> {
        try {
            const { resumptionToken, onresumptiontoken } = options || {};

            if (resumptionToken) {
                // If we have a last event ID, we need to reconnect the SSE stream.
                // Thread `requestSignal` through so the resumed GET honours the
                // same per-request abort as the original POST — modern-era
                // cancel-via-stream-close routes through `requestSignal`, and
                // without it a resumed long-running request would not cancel.
                this._startOrAuthSse({
                    resumptionToken,
                    replayMessageId: isJSONRPCRequest(message) ? message.id : undefined,
                    requestSignal: options?.requestSignal
                }).catch(error => this.onerror?.(error));
                return;
            }

            const headers = await this._commonHeaders();
            this._applyBodyDerivedHeaders(headers, message);
            // Per-request additional headers (the Client passes SEP-2243
            // `Mcp-Param-*` here on a 2026-07-28 connection). Reserved
            // standard/auth header names are skipped so a caller cannot
            // accidentally override the body-derived or connection-level
            // headers — `Headers.set` overwrites, so the only way to keep the
            // transport-owned values authoritative is to refuse to write over
            // them here.
            if (options?.headers !== undefined) {
                for (const [name, value] of Object.entries(options.headers)) {
                    if (RESERVED_REQUEST_HEADER_NAMES.has(name.toLowerCase())) continue;
                    headers.set(name, value);
                }
            }
            headers.set('content-type', 'application/json');
            const userAccept = headers.get('accept');
            const types = [...(userAccept?.split(',').map(s => s.trim().toLowerCase()) ?? []), 'application/json', 'text/event-stream'];
            headers.set('accept', [...new Set(types)].join(', '));
            setMcpStandardPostHeaders(headers, message);

            // Per-request abort: when the caller supplies a request-scoped
            // signal (the `subscriptions/listen` driver), aborting it cancels
            // this POST and its SSE response stream without closing the
            // transport.
            const transportSignal = this._abortController?.signal;
            const signal =
                options?.requestSignal !== undefined && transportSignal !== undefined
                    ? anySignal(transportSignal, options.requestSignal)
                    : (options?.requestSignal ?? transportSignal);
            const init = {
                ...this._requestInit,
                method: 'POST',
                headers,
                body: JSON.stringify(message),
                signal
            };

            const response = await (this._fetch ?? fetch)(this._url, init);

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
                        // Preserve any union accumulated by `_stepUpAuthorize` so a 401
                        // mid-chain does not narrow `_scope` back to the challenge value.
                        this._scope = computeScopeUnion(this._scope, scope);
                    }

                    if (this._authProvider.onUnauthorized && !isAuthRetry) {
                        await this._authProvider.onUnauthorized({
                            response,
                            serverUrl: this._url,
                            fetchFn: this._fetchWithInit
                        });
                        await response.text?.().catch(() => {});
                        // Purposely _not_ awaited, so we don't call onerror twice
                        return this._send(message, options, true, stepUpRetries);
                    }
                    await response.text?.().catch(() => {});
                    if (isAuthRetry) {
                        throw new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, 'Server returned 401 after re-authentication', {
                            status: 401,
                            statusText: response.statusText
                        });
                    }
                    throw new UnauthorizedError();
                }

                const text = await response.text?.().catch(() => null);

                if (response.status === 403) {
                    const { resourceMetadataUrl, scope, error, errorDescription } = extractWWWAuthenticateParams(response);

                    if (error === 'insufficient_scope') {
                        const result = await this._stepUpAuthorize(
                            { scope, resourceMetadataUrl, errorDescription, statusText: response.statusText, text },
                            stepUpRetries
                        );
                        if (result !== 'AUTHORIZED') {
                            throw new UnauthorizedError();
                        }
                        return this._send(message, options, isAuthRetry, stepUpRetries + 1);
                    }
                }

                // SEP-2243 (and the rest of the inbound validation ladder)
                // emit ladder rejections as HTTP 400 carrying a JSON-RPC error
                // response body. Surface those in-band so `Protocol._onresponse`
                // converts them to a typed `ProtocolError` matched to the
                // pending request id — instead of an opaque transport error.
                // Any 400 whose body is not a well-formed JSON-RPC error
                // response (or whose id does not match an outstanding request)
                // still falls through to the generic `SdkHttpError`.
                //
                // Modern-era only: gated on the outbound message carrying a
                // 2026-07-28 envelope claim (the same gate the body-derived
                // `mcp-method`/`mcp-name` headers use), so a legacy-era
                // exchange keeps surfacing 400 as `SdkHttpError` exactly as
                // before — the changeset's "legacy-era paths are unchanged"
                // claim stays true and existing
                // `e instanceof SdkHttpError && e.status === 400` callers do
                // not silently stop matching.
                if (response.status === 400 && typeof text === 'string' && this._isModernEnvelopedRequest(message)) {
                    try {
                        const parsed = JSONRPCMessageSchema.parse(JSON.parse(text));
                        const requests = (Array.isArray(message) ? message : [message]).filter(m => isJSONRPCRequest(m));
                        if (isJSONRPCErrorResponse(parsed) && requests.some(r => r.id === parsed.id)) {
                            this.onmessage?.(parsed);
                            return;
                        }
                    } catch {
                        // not a JSON-RPC error body — fall through to the generic SdkHttpError below.
                    }
                }

                throw new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, `Error POSTing to endpoint: ${text}`, {
                    status: response.status,
                    statusText: response.statusText,
                    text
                });
            }

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
                    this._handleSseStream(
                        response.body,
                        {
                            onresumptiontoken,
                            requestSignal: options?.requestSignal,
                            onRequestStreamEnd: options?.onRequestStreamEnd
                        },
                        false
                    );
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
            // Intentional per-request abort BEFORE response headers (the
            // `subscriptions/listen` driver aborting its `requestSignal`):
            // fetch rejects with AbortError. Same guard as
            // `_handleSseStream`'s `isIntentionalAbort` — do not surface a
            // misleading onerror; still rethrow so `listen()`'s send-catch
            // settles the per-subscription state machine.
            if (options?.requestSignal?.aborted !== true) {
                this.onerror?.(error as Error);
            }
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
                throw new SdkHttpError(
                    SdkErrorCode.ClientHttpFailedToTerminateSession,
                    `Failed to terminate session: ${response.statusText}`,
                    {
                        status: response.status,
                        statusText: response.statusText
                    }
                );
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
