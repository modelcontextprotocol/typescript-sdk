import type {
    JSONRPCErrorResponse,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResponse,
    JSONRPCResultResponse,
    Notification,
    Request,
    RequestId,
    Result
} from '../types/types.js';
import type { AnySchema, SchemaOutput } from '../util/schema.js';
import type { BaseContext, NotificationOptions, RequestOptions } from './protocol.js';

/**
 * Host interface that a ProtocolModule uses to interact with the Protocol instance.
 * Provided to the module via bind().
 * @internal
 */
export interface ProtocolModuleHost {
    request<T extends AnySchema>(request: Request, resultSchema: T, options?: RequestOptions): Promise<SchemaOutput<T>>;
    notification(notification: Notification, options?: NotificationOptions): Promise<void>;
    reportError(error: Error): void;
    removeProgressHandler(token: number): void;
    registerHandler(method: string, handler: (request: JSONRPCRequest, ctx: BaseContext) => Promise<Result>): void;
    sendOnResponseStream(message: JSONRPCNotification | JSONRPCRequest, relatedRequestId: RequestId): Promise<void>;
}

/**
 * Context provided to a module when processing an inbound request.
 * @internal
 */
export interface InboundContext {
    sessionId?: string;
    sendNotification: (notification: Notification, options?: NotificationOptions) => Promise<void>;
    sendRequest: <U extends AnySchema>(request: Request, resultSchema: U, options?: RequestOptions) => Promise<SchemaOutput<U>>;
}

/**
 * Result returned by a module after processing an inbound request.
 * Provides wrapped send functions and routing for task-related responses.
 * @internal
 */
export interface InboundResult {
    taskContext?: BaseContext['task'];
    sendNotification: (notification: Notification) => Promise<void>;
    sendRequest: <U extends AnySchema>(
        request: Request,
        resultSchema: U,
        options?: Omit<RequestOptions, 'relatedTask'>
    ) => Promise<SchemaOutput<U>>;
    routeResponse: (message: JSONRPCResponse | JSONRPCErrorResponse) => Promise<boolean>;
    hasTaskCreationParams: boolean;
    /**
     * Optional validation to run inside the async handler chain (before the request handler).
     * Throwing here produces a proper JSON-RPC error response, matching the behavior of
     * capability checks on main.
     */
    validateInbound?: () => void;
}

/**
 * Interface for pluggable protocol modules that extend Protocol behavior.
 *
 * A ProtocolModule hooks into Protocol's message lifecycle to intercept,
 * augment, or route messages. Modules are registered via Protocol.registerModule().
 * @internal
 */
export interface ProtocolModule {
    /**
     * Binds this module to a Protocol host, allowing it to send messages
     * and register handlers.
     */
    bind(host: ProtocolModuleHost): void;

    /**
     * Processes an inbound request, extracting module-specific context
     * and wrapping send functions for routing.
     */
    processInboundRequest(request: JSONRPCRequest, ctx: InboundContext): InboundResult;

    /**
     * Processes an outbound request, potentially augmenting it or routing
     * it through a side channel.
     *
     * @returns { queued: true } if the request was routed and should not be sent via transport.
     */
    processOutboundRequest(
        jsonrpcRequest: JSONRPCRequest,
        options: RequestOptions | undefined,
        messageId: number,
        responseHandler: (response: JSONRPCResultResponse | Error) => void,
        onError: (error: unknown) => void
    ): { queued: boolean };

    /**
     * Processes an inbound response, potentially consuming it (e.g., for side-channel responses).
     *
     * @returns consumed=true if the response was handled and should not be dispatched normally.
     *          preserveProgress=true if the progress handler should be kept alive after dispatch.
     */
    processInboundResponse(
        response: JSONRPCResponse | JSONRPCErrorResponse,
        messageId: number
    ): { consumed: boolean; preserveProgress: boolean };

    /**
     * Processes an outbound notification, potentially routing it through a side channel.
     *
     * @returns queued=true if the notification was routed and should not be sent via transport.
     *          jsonrpcNotification is the JSONRPC-wrapped notification to send if not queued.
     */
    processOutboundNotification(
        notification: Notification,
        options?: NotificationOptions
    ): Promise<{ queued: boolean; jsonrpcNotification?: JSONRPCNotification }>;

    /**
     * Called when the protocol connection is closed. Cleans up module state.
     */
    onClose(): void;
}
