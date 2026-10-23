import { JSONRPCMessage, MessageExtraInfo, RequestId } from '../types.js';

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Normalizes header init (Headers instance, array of tuples, or plain object)
 * to a plain Record<string, string> for manipulation.
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

/**
 * Creates a fetch function that includes base RequestInit options.
 * This ensures requests inherit settings like credentials, mode, headers, etc. from the base init.
 *
 * @param baseFetch - The base fetch function to wrap (defaults to global fetch)
 * @param baseInit - The base RequestInit to merge with each request
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
            headers: init?.headers ? { ...normalizeHeaders(baseInit.headers), ...normalizeHeaders(init.headers) } : baseInit.headers
        };
        return baseFetch(url, mergedInit);
    };
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

/** @internal Whether `to` has the scheme, host and port of `from`, or is its https form with both on default ports. */
export function isWithinOrigin(from: URL, to: URL): boolean {
    if (from.protocol === to.protocol && from.hostname === to.hostname && from.port === to.port) {
        return true;
    }
    return from.hostname === to.hostname && from.protocol === 'http:' && from.port === '' && to.protocol === 'https:' && to.port === '';
}

function redirectTarget(response: Response, requestUrl: string | URL): URL | undefined {
    const location = REDIRECT_STATUSES.includes(response.status) ? response.headers.get('location') : null;
    try {
        return location ? new URL(location, requestUrl) : undefined;
    } catch {
        return undefined;
    }
}

/** @internal Follows the redirect in `response` while it stays within the origin of `url`; undefined when `response` is to be used as is. */
export function followWithinOrigin(
    baseFetch: FetchLike,
    url: string | URL,
    init: RequestInit | undefined,
    response: Response,
    followed = 0
): Promise<Response> | undefined {
    const target = redirectTarget(response, url);
    // 301, 302 and 303 turn a request with a body into a GET, so only 307 and 308 are followed for those.
    const keepsMethod = response.status === 307 || response.status === 308 || (init?.method ?? 'GET').toUpperCase() === 'GET';
    if (!target || followed === MAX_REDIRECTS || !keepsMethod) {
        return undefined;
    }

    const from = new URL(url);
    const addsUserinfo = (target.username || target.password) && (target.username !== from.username || target.password !== from.password);
    if (addsUserinfo || !isWithinOrigin(from, target)) {
        return undefined;
    }

    return Promise.resolve(response.body?.cancel())
        .then(() => baseFetch(target, { ...init, redirect: 'manual' }))
        .then(next => followWithinOrigin(baseFetch, target, init, next, followed + 1) ?? next);
}

const followingFetches = new WeakSet<FetchLike>();

/** @internal Wraps a fetch for `redirectPolicy: 'follow'`: `fetchWithinOrigin` returns the result as it is, so redirects are left to the fetch. */
export function fetchLeavingRedirects(baseFetch?: FetchLike): FetchLike {
    const following: FetchLike = (url, init) => (baseFetch ?? fetch)(url, init);
    followingFetches.add(following);
    return following;
}

/** @internal Wraps a fetch so it follows a redirect only within the request's origin; any other redirect response is returned as is. */
export function fetchWithinOrigin(baseFetch: FetchLike = fetch): FetchLike {
    if (followingFetches.has(baseFetch)) {
        return baseFetch;
    }
    return (url: string | URL, init?: RequestInit): Promise<Response> => {
        if (init?.redirect === 'error' || init?.redirect === 'manual') {
            return baseFetch(url, init);
        }
        // Browsers answer a manual redirect with an opaque response: it is returned and nothing is followed.
        return Promise.resolve(baseFetch(url, { ...init, redirect: 'manual' })).then(
            response => followWithinOrigin(baseFetch, url, init, response) ?? response
        );
    };
}

/** @internal Describes a redirect that `fetchWithinOrigin` returned unfollowed, naming its target without userinfo, query or fragment. */
export function unfollowedRedirect(response: Response, requestUrl: string | URL): string | undefined {
    if (response.type === 'opaqueredirect') {
        return 'Redirect not followed: this runtime does not expose the redirect target';
    }

    const from = response.url || requestUrl;
    const target = redirectTarget(response, from);
    if (!target) {
        return undefined;
    }

    target.username = target.password = target.search = target.hash = '';
    if (target.protocol === 'http:' && new URL(from).protocol === 'https:') {
        target.protocol = 'https:';
        return `Redirect to plain http not followed; try ${target.href} instead`;
    }
    return `Redirect to ${target.href} not followed`;
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
     * NOTE: This method should not be called explicitly when using Client, Server, or Protocol classes, as they will implicitly call start().
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
     * Callback for when the connection is closed for any reason.
     *
     * This should be invoked when close() is called as well.
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
     * Includes the requestInfo and authInfo if the transport is authenticated.
     *
     * The requestInfo can be used to get the original request information (headers, etc.)
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
}
