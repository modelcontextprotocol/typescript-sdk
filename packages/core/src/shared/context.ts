import type { RequestTaskStoreInterface } from '../experimental/requestTaskStore.js';
import type { AuthInfo, JSONRPCRequest, Notification, Request, RequestId, RequestMeta } from '../types/types.js';
import type { AnySchema, SchemaOutput } from '../util/zodCompat.js';
import type { NotificationOptions, RequestOptions } from './protocol.js';

/**
 * MCP-level context for a request being handled.
 * Contains information about the JSON-RPC request and session.
 */
export type McpContext = {
    /**
     * The JSON-RPC ID of the request being handled.
     * This can be useful for tracking or logging purposes.
     */
    requestId: RequestId;
    /**
     * The method of the request.
     */
    method: string;
    /**
     * The metadata of the request.
     */
    _meta?: RequestMeta;
    /**
     * The session ID of the request.
     */
    sessionId?: string;
};

/**
 * Interface for protocol operations needed by context classes.
 * This allows the base context to work with both Client and Server.
 */
export interface ProtocolInterface<RequestT extends Request = Request, NotificationT extends Notification = Notification> {
    /**
     * Sends a notification through the protocol.
     */
    notification(notification: NotificationT, options?: NotificationOptions): Promise<void>;

    /**
     * Sends a request through the protocol.
     */
    request<U extends AnySchema>(request: RequestT, resultSchema: U, options?: RequestOptions): Promise<SchemaOutput<U>>;
}

/**
 * Base request context with fields common to both client and server.
 */
export type BaseRequestContext = {
    /**
     * An abort signal used to communicate if the request was cancelled.
     */
    signal: AbortSignal;
    /**
     * The authentication information, if available.
     */
    authInfo?: AuthInfo;
};

/**
 * Server-specific request context with HTTP request details.
 * Extends BaseRequestContext with fields only available on the server side.
 */
export type ServerRequestContext = BaseRequestContext & {
    /**
     * The URI of the incoming HTTP request.
     */
    uri: URL;
    /**
     * The headers of the incoming HTTP request.
     */
    headers: Headers;
    /**
     * Stream control methods for SSE connections.
     */
    stream: {
        /**
         * Closes the SSE stream for this request, triggering client reconnection.
         * Only available when using StreamableHTTPServerTransport with eventStore configured.
         * Use this to implement polling behavior during long-running operations.
         */
        closeSSEStream: (() => void) | undefined;
        /**
         * Closes the standalone GET SSE stream, triggering client reconnection.
         * Only available when using StreamableHTTPServerTransport with eventStore configured.
         * Use this to implement polling behavior for server-initiated notifications.
         */
        closeStandaloneSSEStream: (() => void) | undefined;
    };
};

/**
 * Client-specific request context.
 * Clients don't receive HTTP requests, so this is minimal.
 * Extends BaseRequestContext with any client-specific fields.
 */
export type ClientRequestContext = BaseRequestContext & {
    // Client doesn't receive HTTP requests, just JSON-RPC messages over transport.
    // Additional client-specific fields can be added here if needed.
};

/**
 * Task-related context for task-augmented requests.
 */
export type TaskContext = {
    /**
     * The ID of the task.
     */
    id: string;
    /**
     * The task store for managing task state.
     */
    store: RequestTaskStoreInterface;
    /**
     * The requested TTL for the task, or null if not specified.
     */
    requestedTtl: number | null;
};

/**
 * Base context interface for request handlers.
 * Generic over request type, notification type, and request context type.
 *
 * @typeParam RequestT - The type of requests that can be sent from this context
 * @typeParam NotificationT - The type of notifications that can be sent from this context
 * @typeParam RequestContextT - The type of request context (server or client specific)
 */
export interface ContextInterface<
    RequestT extends Request = Request,
    NotificationT extends Notification = Notification,
    RequestContextT extends BaseRequestContext = BaseRequestContext
> {
    /**
     * MCP-level context containing request ID, method, metadata, and session info.
     */
    mcpCtx: McpContext;
    /**
     * Request-specific context (transport/HTTP details).
     */
    requestCtx: RequestContextT;
    /**
     * Task context if this is a task-augmented request, undefined otherwise.
     */
    taskCtx: TaskContext | undefined;
    /**
     * Sends a notification that relates to the current request being handled.
     * This is used by certain transports to correctly associate related messages.
     */
    sendNotification: (notification: NotificationT) => Promise<void>;
    /**
     * Sends a request that relates to the current request being handled.
     * This is used by certain transports to correctly associate related messages.
     */
    sendRequest: <U extends AnySchema>(request: RequestT, resultSchema: U, options?: RequestOptions) => Promise<SchemaOutput<U>>;
}

/**
 * Arguments for constructing a BaseContext.
 */
export interface BaseContextArgs<RequestContextT extends BaseRequestContext = BaseRequestContext> {
    /**
     * The JSON-RPC request being handled.
     */
    request: JSONRPCRequest;
    /**
     * The MCP context for the request.
     */
    mcpContext: McpContext;
    /**
     * The request-specific context (transport/HTTP details).
     */
    requestCtx: RequestContextT;
    /**
     * The task context, if the request is task-augmented.
     */
    task: TaskContext | undefined;
}

/**
 * Abstract base class for context objects passed to request handlers.
 * Provides shared implementation for sendNotification and sendRequest.
 *
 * @typeParam RequestT - The type of requests that can be sent from this context
 * @typeParam NotificationT - The type of notifications that can be sent from this context
 * @typeParam RequestContextT - The type of request context (server or client specific)
 */
export abstract class BaseContext<
    RequestT extends Request = Request,
    NotificationT extends Notification = Notification,
    RequestContextT extends BaseRequestContext = BaseRequestContext
> implements ContextInterface<RequestT, NotificationT, RequestContextT>
{
    /**
     * The MCP context - Contains information about the current MCP request and session.
     */
    public readonly mcpCtx: McpContext;

    /**
     * The request context with transport-specific fields.
     */
    public readonly requestCtx: RequestContextT;

    /**
     * The task context, if the request is task-augmented.
     */
    public readonly taskCtx: TaskContext | undefined;

    /**
     * Returns the protocol instance for sending notifications and requests.
     * Subclasses must implement this to provide the appropriate Client or Server instance.
     */
    protected abstract getProtocol(): ProtocolInterface<RequestT, NotificationT>;

    constructor(args: BaseContextArgs<RequestContextT>) {
        this.mcpCtx = {
            requestId: args.request.id,
            method: args.mcpContext.method,
            _meta: args.mcpContext._meta,
            sessionId: args.mcpContext.sessionId
        };
        this.requestCtx = args.requestCtx;
        // Use the task object directly instead of copying to preserve any getters
        // (e.g., the id getter that updates after createTask is called)
        this.taskCtx = args.task;
    }

    /**
     * Sends a notification that relates to the current request being handled.
     * This is used by certain transports to correctly associate related messages.
     * Note: This is an arrow function to preserve 'this' binding when destructured.
     */
    public sendNotification = async (notification: NotificationT): Promise<void> => {
        const notificationOptions: NotificationOptions = { relatedRequestId: this.mcpCtx.requestId };

        // Only set relatedTask if there's a valid (non-empty) task ID
        // Empty task ID means no task has been created yet or task queuing isn't applicable
        if (this.taskCtx && this.taskCtx.id) {
            notificationOptions.relatedTask = { taskId: this.taskCtx.id };
        }

        return this.getProtocol().notification(notification, notificationOptions);
    };

    /**
     * Sends a request that relates to the current request being handled.
     * This is used by certain transports to correctly associate related messages.
     * Note: This is an arrow function to preserve 'this' binding when destructured.
     */
    public sendRequest = async <U extends AnySchema>(
        request: RequestT,
        resultSchema: U,
        options?: RequestOptions
    ): Promise<SchemaOutput<U>> => {
        const requestOptions: RequestOptions = { ...options, relatedRequestId: this.mcpCtx.requestId };

        // Only set relatedTask if there's a valid (non-empty) task ID
        // Empty task ID means no task has been created yet or task queuing isn't applicable
        const taskId = this.taskCtx?.id;
        if (taskId) {
            requestOptions.relatedTask = { taskId };

            // Set task status to input_required when sending a request within a task context
            if (this.taskCtx?.store) {
                await this.taskCtx.store.updateTaskStatus(taskId, 'input_required');
            }
        }

        return await this.getProtocol().request(request, resultSchema, requestOptions);
    };
}
