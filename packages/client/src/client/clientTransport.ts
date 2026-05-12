import type {
    JSONRPCErrorResponse,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResultResponse,
    Notification,
    Progress,
    RequestId,
    Transport
} from '@modelcontextprotocol/core';

/**
 * Per-call options for {@linkcode ClientTransport.fetch}.
 */
export type ClientFetchOptions = {
    /** Abort the in-flight request. */
    signal?: AbortSignal;
    /** Called for each `notifications/progress` received before the terminal response. */
    onprogress?: (progress: Progress) => void;
    /** Called for each non-progress notification received before the terminal response. */
    onnotification?: (notification: JSONRPCNotification) => void;
    /**
     * Called for each server-initiated request received on the response stream.
     * Must return the response to send back. If absent, such requests fail with
     * `MethodNotFound`.
     */
    onrequest?: (request: JSONRPCRequest) => Promise<JSONRPCResultResponse | JSONRPCErrorResponse>;
    /** Per-request timeout (ms). */
    timeout?: number;
    /** Reset {@linkcode timeout} when a progress notification arrives. */
    resetTimeoutOnProgress?: boolean;
    /** Absolute upper bound (ms) regardless of progress. */
    maxTotalTimeout?: number;
    /** Associates this outbound request with an inbound one (pipe transports only). */
    relatedRequestId?: RequestId;
    /** Resumption token to continue a previous request (SHTTP only). */
    resumptionToken?: string;
    /** Called when the resumption token changes (SHTTP only). */
    onresumptiontoken?: (token: string) => void;
};

/**
 * Request-shaped client transport. One JSON-RPC request in, one terminal response out.
 * The transport may be stateful internally (session id, protocol version) but the
 * contract is per-call.
 *
 * Legacy pipe-shaped {@linkcode Transport} instances are accepted by
 * {@linkcode client/client.Client.connect | Client.connect} unchanged; this interface
 * is for transports that natively implement a fetch-per-request shape.
 */
export interface ClientTransport {
    /** Explicit shape brand so {@linkcode isClientTransport} can discriminate without duck-typing. */
    readonly kind: 'request';

    /**
     * Send one JSON-RPC request and resolve with the terminal response. Progress and
     * notifications received before the response are surfaced via the callbacks in
     * {@linkcode ClientFetchOptions}.
     */
    fetch(request: JSONRPCRequest, opts?: ClientFetchOptions): Promise<JSONRPCResultResponse | JSONRPCErrorResponse>;

    /** Send a fire-and-forget notification. */
    notify(notification: Notification): Promise<void>;

    /**
     * Open a server-to-client stream for unsolicited notifications and server-initiated
     * requests. Optional; transports that cannot stream omit this.
     */
    subscribe?(opts?: Pick<ClientFetchOptions, 'onrequest'>): AsyncIterable<JSONRPCNotification>;

    /** Close the transport and release resources. */
    close(): Promise<void>;

    /** Set by the SDK after handshake so subsequent calls carry `mcp-protocol-version`. */
    setProtocolVersion?(version: string): void;
}

/**
 * Type guard for {@linkcode ClientTransport}. A transport that implements both shapes
 * (e.g. a future SHTTP client) is treated as request-shaped.
 */
export function isClientTransport(t: Transport | ClientTransport): t is ClientTransport {
    return (t as ClientTransport).kind === 'request';
}
