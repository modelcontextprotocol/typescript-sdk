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

/** Loopback hostnames and IPs */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Checks if a hostname represents a loopback or internal metadata address.
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
    if (LOOPBACK_HOSTS.has(hostname.toLowerCase())) return true;

    // IPv4 127.0.0.0/8
    if (/^127(?:\.\d{1,3}){3}$/.test(hostname)) return true;

    // Cloud metadata IPv4 169.254.169.254 (link-local)
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') return true;

    // IPv4 link-local (169.254.0.0/16)
    if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;

    // IPv4 Private subnets (RFC 1918): 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
    if (/^10(?:\.\d{1,3}){3}$/.test(hostname)) return true;
    if (/^192\.168(?:\.\d{1,3}){2}$/.test(hostname)) return true;
    const match172 = hostname.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
    if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) return true;

    return false;
}

/**
 * Validates whether a redirect target URL is safe to follow.
 * Prevents SSRF / protocol confusion by rejecting redirection from public endpoints into internal/loopback hosts.
 */
export function isSafeRedirectTarget(sourceUrl: string | URL, targetUrl: string | URL, allowLoopback: boolean = false): boolean {
    const src = new URL(String(sourceUrl));
    const tgt = new URL(String(targetUrl), src);

    // If target protocol is not http or https, reject
    if (tgt.protocol !== 'http:' && tgt.protocol !== 'https:') {
        return false;
    }

    if (allowLoopback) {
        return true;
    }

    const srcIsPrivate = isPrivateOrLoopbackHost(src.hostname);
    const tgtIsPrivate = isPrivateOrLoopbackHost(tgt.hostname);

    // If source was already a private/loopback service, allowing redirect to another private service is acceptable
    if (srcIsPrivate) {
        return true;
    }

    // If source was public, NEVER allow redirecting into private/loopback addresses
    return !tgtIsPrivate;
}

export interface FetchWithInitOptions {
    baseInit?: RequestInit;
    allowLoopbackRedirects?: boolean;
    maxRedirects?: number;
}

/**
 * Creates a fetch function that includes base `RequestInit` options and safely handles redirects.
 * Protects against SSRF / protocol confusion by validating redirect targets before following them.
 *
 * @param baseFetch - The base fetch function to wrap (defaults to global `fetch`)
 * @param optionsOrBaseInit - Options object or base RequestInit
 * @returns A wrapped fetch function that handles options and redirect security
 */
export function createFetchWithInit(baseFetch: FetchLike = fetch, optionsOrBaseInit?: RequestInit | FetchWithInitOptions): FetchLike {
    const isOptionsObject = Boolean(
        optionsOrBaseInit &&
            typeof optionsOrBaseInit === 'object' &&
            ('baseInit' in optionsOrBaseInit || 'allowLoopbackRedirects' in optionsOrBaseInit || 'maxRedirects' in optionsOrBaseInit)
    );
    const baseInit: RequestInit | undefined = isOptionsObject
        ? (optionsOrBaseInit as FetchWithInitOptions).baseInit
        : (optionsOrBaseInit as RequestInit | undefined);
    const allowLoopbackRedirects = isOptionsObject ? Boolean((optionsOrBaseInit as FetchWithInitOptions).allowLoopbackRedirects) : false;
    const maxRedirects =
        isOptionsObject && typeof (optionsOrBaseInit as FetchWithInitOptions).maxRedirects === 'number'
            ? (optionsOrBaseInit as FetchWithInitOptions).maxRedirects!
            : 5;

    // Fast return if no options/init are provided at all
    if (!optionsOrBaseInit) {
        return baseFetch;
    }

    return async (url: string | URL, init?: RequestInit): Promise<Response> => {
        const mergedInit: RequestInit = {
            ...baseInit,
            ...init,
            headers: init?.headers ? { ...normalizeHeaders(baseInit?.headers), ...normalizeHeaders(init.headers) } : baseInit?.headers
        };

        // If caller explicitly configured redirect mode (e.g. 'manual' or 'error'), delegate directly to baseFetch
        if (mergedInit.redirect && mergedInit.redirect !== 'follow') {
            return baseFetch(url, mergedInit);
        }

        // Intercept redirects to enforce SSRF security checks
        let currentUrl: string | URL = url;
        let currentInit: RequestInit = { ...mergedInit, redirect: 'manual' };
        let redirectCount = 0;

        while (true) {
            const response = await baseFetch(currentUrl, currentInit);
            if (!response) {
                return response;
            }

            // Check if response is a redirect status (301, 302, 303, 307, 308)
            const isRedirect =
                response.status >= 301 &&
                response.status <= 308 &&
                response.status !== 304 &&
                response.status !== 305 &&
                response.status !== 306;
            const location = response.headers?.get ? response.headers.get('location') : undefined;

            if (isRedirect && location) {
                if (redirectCount >= maxRedirects) {
                    throw new Error(`Too many redirects (max: ${maxRedirects})`);
                }

                if (!isSafeRedirectTarget(currentUrl, location, allowLoopbackRedirects)) {
                    throw new Error(
                        `Insecure redirect rejected: redirection to internal/loopback address '${location}' from '${String(currentUrl)}' is prohibited.`
                    );
                }

                const nextUrl = new URL(location, String(currentUrl));
                redirectCount++;
                currentUrl = nextUrl;

                // For 303 See Other, change method to GET and drop body (RFC 7231)
                if (response.status === 303) {
                    currentInit = {
                        ...currentInit,
                        method: 'GET',
                        body: undefined
                    };
                }
                continue;
            }

            return response;
        }
    };
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
