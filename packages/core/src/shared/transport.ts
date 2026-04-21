import type {
    JSONRPCErrorResponse,
    JSONRPCMessage,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResultResponse,
    MessageExtraInfo,
    RequestId
} from '../types/index.js';
import type { RequestEnv } from './context.js';
import type { TaskManager } from './taskManager.js';

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
            headers: init?.headers ? { ...normalizeHeaders(baseInit.headers), ...normalizeHeaders(init.headers) } : baseInit.headers
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
};
/**
 * Describes the minimal contract for a persistent, bidirectional MCP message channel
 * (stdio, WebSocket, in-memory). The SDK wraps this in a {@linkcode StreamDriver} to
 * do request/response correlation.
 *
 * For request/response-shaped transports (Streamable HTTP), see {@linkcode RequestTransport}.
 */
export interface ChannelTransport {
    /**
     * Explicit shape brand. Optional (defaults to `'channel'`) so existing
     * `Transport` implementations don't need to declare it.
     */
    readonly kind?: 'channel';

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

/** @deprecated Use {@linkcode ChannelTransport}. Renamed for clarity alongside {@linkcode RequestTransport}; kept as an alias. */
export type Transport = ChannelTransport;

/**
 * Options McpServer passes when wiring a {@linkcode ChannelTransport} via {@linkcode attachChannelTransport}.
 * @internal
 */
export type AttachOptions = {
    supportedProtocolVersions?: string[];
    debouncedNotificationMethods?: string[];
    taskManager?: TaskManager;
    buildEnv?: (extra: MessageExtraInfo | undefined, base: RequestEnv) => RequestEnv;
    onclose?: () => void;
    onerror?: (error: Error) => void;
};

/**
 * A request/response-shaped server transport (e.g. Streamable HTTP). Unlike
 * {@linkcode ChannelTransport}, there is no persistent pipe: the transport receives
 * one HTTP request at a time and calls {@linkcode onrequest} for each, streaming the
 * yielded messages back as the HTTP response.
 *
 * The `on*` callback slots are set by `McpServer.connect()`; the transport calls them
 * per inbound message. The transport itself never imports or references a `Dispatcher`.
 */
export interface RequestTransport {
    /** Explicit shape brand. Required so {@linkcode isRequestTransport} can discriminate without duck-typing. */
    readonly kind: 'request';

    /**
     * Callback slot for inbound JSON-RPC requests. Set by `McpServer.connect()`.
     * The transport calls this per request and writes the yielded messages
     * (notifications + one terminal response) to the HTTP response stream.
     */
    onrequest?: ((req: JSONRPCRequest, env?: RequestEnv) => AsyncIterable<JSONRPCMessage>) | undefined;

    /** Callback slot for inbound notifications (e.g. `notifications/initialized`). */
    onnotification?: (n: JSONRPCNotification) => void | Promise<void>;

    /**
     * Callback slot for inbound JSON-RPC responses (a client POSTing back the answer to
     * a server-initiated request). Returns `true` if the response was claimed.
     */
    onresponse?: (r: JSONRPCResultResponse | JSONRPCErrorResponse) => boolean;

    /** Aborts in-flight handlers and releases resources (open SSE streams, session map). */
    close(): Promise<void>;

    /**
     * 2025-11 back-compat: write an unsolicited notification to the session's standalone
     * GET subscription stream.
     */
    notify?(n: JSONRPCNotification): Promise<void>;

    /**
     * 2025-11 back-compat: send an unsolicited server→client request via the standalone
     * GET stream and await the client's POSTed-back response.
     */
    request?(r: JSONRPCRequest): Promise<JSONRPCResultResponse | JSONRPCErrorResponse>;

    /** Callback for when the transport is closed for any reason. */
    onclose?: (() => void) | undefined;
    /** Callback for transport-level errors. */
    onerror?: ((error: Error) => void) | undefined;
    /** Session id (single-session compat mode). */
    sessionId?: string | undefined;
}

/** Type guard distinguishing {@linkcode RequestTransport} from {@linkcode ChannelTransport}. */
export function isRequestTransport(t: ChannelTransport | RequestTransport): t is RequestTransport {
    return (t as RequestTransport).kind === 'request';
}
