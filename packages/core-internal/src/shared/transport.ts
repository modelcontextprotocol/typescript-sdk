import type { JSONRPCMessage, MessageExtraInfo, RequestId } from '../types/index';

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Normalizes `HeadersInit` to a plain `Record<string, string>` for manipulation.
 * Handles `Headers` objects, arrays of tuples, and plain objects.
 */
export function normalizeHeaders(headers: RequestInit['headers'] | undefined): Record<string, string> {
    if (!headers) return {};

    if (headers instanceof Headers) {
        return Object.fromEntries(headers.entries());
    }

    if (Array.isArray(headers)) {
        return Object.fromEntries(headers);
    }

    return { ...(headers as Record<string, string>) };
}

function mergeHeaders(base: RequestInit['headers'], override: RequestInit['headers']): Record<string, string> {
    const overrideHeaders = normalizeHeaders(override);
    const overrideNames = new Set(Object.keys(overrideHeaders).map(name => name.toLowerCase()));

    return {
        ...Object.fromEntries(Object.entries(normalizeHeaders(base)).filter(([name]) => !overrideNames.has(name.toLowerCase()))),
        ...overrideHeaders
    };
}

/**
 * Creates a fetch function that includes base `RequestInit` options.
 * This ensures requests inherit settings like credentials, mode, headers, etc. from the base init.
 *
 * @param baseFetch - The base fetch function to wrap (defaults to global `fetch`)
 * @param baseInit - The base `RequestInit` to merge with each request
 * @returns A wrapped fetch function that merges base options with call-specific options
 */
export function createFetchWithInit(baseFetch: FetchLike = fetch, baseInit?: RequestInit): FetchLike {
    if (!baseInit) {
        return baseFetch;
    }

    // Return a wrapped fetch that merges base RequestInit with call-specific init
    return async (url: string | URL, init?: RequestInit): Promise<Response> => {
        const mergedInit: RequestInit = {
            ...baseInit,
            ...init,
            // Headers need special handling - merge instead of replace
            headers: init?.headers ? mergeHeaders(baseInit.headers, init.headers) : baseInit.headers
        };
        return baseFetch(url, mergedInit);
    };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/** Whether `to` has the scheme, host and port of `from`, or is its https form with both on the default port. */
export function isWithinOrigin(from: URL, to: URL): boolean {
    if (from.protocol === to.protocol && from.host === to.host) return true;
    return from.protocol === 'http:' && to.protocol === 'https:' && from.hostname === to.hostname && !from.port && !to.port;
}

/** The URL that a redirect `response` to a request for `url` points at, if it names one. */
function redirectTarget(url: string | URL, response: Response): URL | undefined {
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers?.get('location') : undefined;
    if (!location) return undefined;
    try {
        return new URL(location, url);
    } catch {
        return undefined;
    }
}

const leftToFetch = new WeakSet<FetchLike>();

/** A copy of `baseFetch` that `fetchWithinOrigin` returns as it is, which leaves redirects to `baseFetch`. */
export function fetchLeavingRedirects(baseFetch: FetchLike): FetchLike {
    const copy: FetchLike = (url, init) => baseFetch(url, init);
    leftToFetch.add(copy);
    return copy;
}

/** Wraps `baseFetch` to follow a redirect only when it keeps the method and stays within the origin of the request. */
export function fetchWithinOrigin(baseFetch: FetchLike): FetchLike {
    if (leftToFetch.has(baseFetch)) return baseFetch;
    return async (url, init) => {
        // A request that sets `redirect` to 'error' or 'manual' is handed to the base fetch as it is.
        if (init?.redirect === 'error' || init?.redirect === 'manual') return baseFetch(url, init);
        const method = (init?.method ?? 'GET').toUpperCase();
        let current = url;
        for (let followed = 0; ; followed++) {
            // Browsers answer a manual redirect with an opaque response (status 0, no Location); it is returned as it is.
            const response = await baseFetch(current, { ...init, redirect: 'manual' });
            const target = redirectTarget(current, response);
            if (!target || followed === MAX_REDIRECTS) return response;
            const from = new URL(current);
            const keepsMethod = method === 'GET' || response.status === 307 || response.status === 308;
            const keepsUserinfo =
                !(target.username || target.password) || (target.username === from.username && target.password === from.password);
            if (!keepsMethod || !keepsUserinfo || !isWithinOrigin(from, target)) return response;
            await response.text?.().catch(() => {});
            current = target;
        }
    };
}

/** Error text for a redirect `response` to a request for `url` that was not followed, or `undefined` for any other response. */
export function unfollowedRedirect(url: string | URL, response: Response): string | undefined {
    if (response.type === 'opaqueredirect') return 'Redirect not followed: this runtime does not expose where it points';
    const target = redirectTarget(response.url || url, response);
    if (!target) return undefined;
    target.username = target.password = target.search = target.hash = '';
    if (target.protocol === 'http:' && new URL(response.url || url).protocol === 'https:') {
        target.protocol = 'https:';
        return `Redirect from https to plain http not followed; try ${target.href} as the endpoint`;
    }
    return `Redirect to ${target.href} not followed; use that URL as the endpoint if it is the intended server`;
}

/**
 * Options for sending a JSON-RPC message.
 */
export type TransportSendOptions = {
    /**
     * If present, `relatedRequestId` is used to indicate to the transport which incoming request to associate this outgoing message with.
     */
    relatedRequestId?: RequestId | undefined;

    /**
     * The resumption token used to continue long-running requests that were interrupted.
     *
     * This allows clients to reconnect and continue from where they left off, if supported by the transport.
     */
    resumptionToken?: string | undefined;

    /**
     * A callback that is invoked when the resumption token changes, if supported by the transport.
     *
     * This allows clients to persist the latest token for potential reconnection.
     */
    onresumptiontoken?: ((token: string) => void) | undefined;

    /**
     * An abort signal for THIS outbound message's underlying request, when the
     * transport sends one outbound message per underlying request (the
     * Streamable HTTP transport's POST-per-request model). Aborting it cancels
     * the underlying request (and its SSE response stream) without closing the
     * transport. Transports that share a single channel (stdio, in-memory)
     * ignore it.
     */
    requestSignal?: AbortSignal | undefined;

    /**
     * Fired by transports that open a per-request stream (the Streamable HTTP
     * transport's POST-per-request SSE response) when that stream ends or
     * errors for any reason OTHER than a deliberate `requestSignal` abort —
     * i.e. the server closed the stream, the network dropped it, or
     * reconnection was exhausted. Transports that share a single channel
     * (stdio, in-memory) ignore it.
     */
    onRequestStreamEnd?: (() => void) | undefined;

    /**
     * Additional HTTP headers to send with THIS outbound message, when the
     * transport sends one outbound message per underlying HTTP request (the
     * Streamable HTTP transport's POST-per-request model). Transports that
     * share a single channel (stdio, in-memory) ignore it.
     *
     * The Client uses this to attach SEP-2243 `Mcp-Param-{Name}` headers to a
     * `tools/call` request on a 2026-07-28 connection. Values are sent
     * verbatim — encode anything that is not a safe RFC 9110 field value
     * before passing it here.
     */
    headers?: Readonly<Record<string, string>> | undefined;
};
/**
 * Describes the minimal contract for an MCP transport that a client or server can communicate over.
 */
export interface Transport {
    /**
     * Starts processing messages on the transport, including any connection steps that might need to be taken.
     *
     * This method should only be called after callbacks are installed, or else messages may be lost.
     *
     * NOTE: This method should not be called explicitly when using {@linkcode @modelcontextprotocol/client!client/client.Client | Client} or {@linkcode @modelcontextprotocol/server!server/server.Server | Server} classes, as they will implicitly call {@linkcode Transport.start | start()}.
     */
    start(): Promise<void>;

    /**
     * Sends a JSON-RPC message (request or response).
     *
     * If present, `relatedRequestId` is used to indicate to the transport which incoming request to associate this outgoing message with.
     */
    send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;

    /**
     * Closes the connection.
     */
    close(): Promise<void>;

    /**
     * `true` when this transport opens one underlying request per outbound
     * JSON-RPC request (the Streamable HTTP POST-per-request model) and
     * therefore honors {@linkcode TransportSendOptions.requestSignal}. The
     * 2026-07-28 spec makes closing that per-request stream the cancellation
     * signal — the protocol layer aborts `requestSignal` instead of POSTing
     * `notifications/cancelled` when this flag is set on a 2026-era
     * connection. Transports that share a single channel (stdio, in-memory)
     * leave it `undefined`.
     */
    readonly hasPerRequestStream?: boolean;

    /**
     * Callback for when the connection is closed for any reason.
     *
     * This should be invoked when {@linkcode Transport.close | close()} is called as well.
     */
    onclose?: (() => void) | undefined;

    /**
     * Callback for when an error occurs.
     *
     * Note that errors are not necessarily fatal; they are used for reporting any kind of exceptional condition out of band.
     */
    onerror?: ((error: Error) => void) | undefined;

    /**
     * Callback for when a message (request or response) is received over the connection.
     *
     * Includes the {@linkcode MessageExtraInfo.request | request} and {@linkcode MessageExtraInfo.authInfo | authInfo} if the transport is authenticated.
     *
     * The {@linkcode MessageExtraInfo.request | request} can be used to get the original request information (headers, etc.)
     */
    onmessage?: (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void) | undefined;

    /**
     * The session ID generated for this connection.
     */
    sessionId?: string | undefined;

    /**
     * Sets the protocol version used for the connection (called when the initialize response is received).
     */
    setProtocolVersion?: ((version: string) => void) | undefined;

    /**
     * Sets the supported protocol versions for header validation (called during connect).
     * This allows the server to pass its supported versions to the transport.
     */
    setSupportedProtocolVersions?: ((versions: string[]) => void) | undefined;
}
