import type { AuthInfo, JSONRPCMessage, Notification, Request, RequestId, Result } from '../types/index.js';
import type { StandardSchemaV1 } from '../util/standardSchema.js';
import type { NotificationOptions, RequestOptions } from './protocol.js';

/**
 * Per-request environment a transport adapter passes to {@linkcode Dispatcher.dispatch}.
 * Everything is optional; a bare `dispatch()` call works with no transport at all.
 *
 * @internal
 */
export type RequestEnv = {
    /**
     * Sends a request back to the peer (server→client elicitation/sampling, or
     * client→server nested calls). Supplied by {@linkcode StreamDriver} when running
     * over a persistent pipe, or by an HTTP adapter that has a backchannel. When
     * undefined, `ctx.mcpReq.send` throws {@linkcode SdkErrorCode.NotConnected}.
     */
    send?: (request: Request, options?: RequestOptions) => Promise<Result>;

    /** Validated auth token info for HTTP transports. */
    authInfo?: AuthInfo;

    /** Original HTTP `Request` (Fetch API), if any. */
    httpReq?: globalThis.Request;

    /** Abort signal for the inbound request. If omitted, a fresh controller is created. */
    signal?: AbortSignal;

    /** Transport session identifier (legacy `Mcp-Session-Id`). */
    sessionId?: string;

    /** Extension slot. Adapters and middleware populate keys here; copied onto `BaseContext.ext`. */
    ext?: Record<string, unknown>;
};

/**
 * The minimal contract a {@linkcode Dispatcher} owner needs to send outbound
 * requests/notifications to the connected peer. Implemented by
 * {@linkcode StreamDriver} for persistent pipes; request-shaped paths can supply
 * their own.
 *
 * @internal
 */
export interface Outbound {
    /** Send a request to the peer and resolve with the parsed result. */
    request<T extends StandardSchemaV1>(req: Request, resultSchema: T, options?: RequestOptions): Promise<StandardSchemaV1.InferOutput<T>>;
    /** Send a notification to the peer. */
    notification(notification: Notification, options?: NotificationOptions): Promise<void>;
    /** Close the underlying connection. */
    close(): Promise<void>;
    /** Clear a registered progress callback by its message id. Optional; pipe-channels expose this. */
    removeProgressHandler?(messageId: number): void;
    /** Inform the channel which protocol version was negotiated (for header echoing etc.). Optional. */
    setProtocolVersion?(version: string): void;
    /** Write a raw JSON-RPC message on the same stream as a prior request. Optional; pipe-only. */
    sendRaw?(message: JSONRPCMessage, options?: { relatedRequestId?: RequestId }): Promise<void>;
}
