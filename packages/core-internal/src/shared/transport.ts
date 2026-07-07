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

/**
 * Sentinel `headers` value recognized by fetch functions created with
 * {@linkcode createFetchWithInit}: a call whose `init.headers` is this exact
 * object is sent with no headers at all — the base init's headers are
 * suppressed instead of merged underneath or used as a fallback. The sentinel
 * is passed through to the wrapped fetch unchanged, so it suppresses base
 * headers at every level of a nested-wrapper chain; a terminal fetch treats it
 * as an ordinary empty header set.
 *
 * Intended for callers that follow redirects manually: configured headers are
 * scoped to the origin they were sent to, so once a hop leaves that origin the
 * caller passes this sentinel to keep the wrapper from re-applying its base
 * headers on the cross-origin request.
 */
export const OMIT_BASE_HEADERS: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Creates a fetch function that includes base `RequestInit` options.
 * This ensures requests inherit settings like credentials, mode, headers, etc. from the base init.
 *
 * Headers merge instead of replacing: per-call headers are laid over the base
 * headers, and a call without headers falls back to the base headers. Passing
 * the `OMIT_BASE_HEADERS` sentinel (internal barrel only) as the call's
 * `headers` opts out of both — the request is sent with no headers.
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
            // Headers need special handling - merge instead of replace. The
            // OMIT_BASE_HEADERS sentinel suppresses the base headers and is passed
            // through as-is so nested wrappers honor it too (a terminal fetch treats
            // the frozen empty object as an ordinary empty header set).
            headers:
                init?.headers === OMIT_BASE_HEADERS
                    ? OMIT_BASE_HEADERS
                    : init?.headers
                      ? { ...normalizeHeaders(baseInit.headers), ...normalizeHeaders(init.headers) }
                      : baseInit.headers
        };
        return baseFetch(url, mergedInit);
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
