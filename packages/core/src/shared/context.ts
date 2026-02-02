import type { RequestTaskStoreInterface } from '../experimental/requestTaskStore.js';
import type { AuthInfo, JSONRPCRequest, Notification, Request, RequestId, RequestMeta, Result } from '../types/types.js';
import type { AnySchema, SchemaOutput } from '../util/zodCompat.js';
import type { NotificationOptions, Protocol, RequestOptions } from './protocol.js';

/**
 * MCP request context containing protocol-level information.
 * Includes request ID, method, metadata, and abort signal.
 */
export type McpReqContext<RequestT extends Request = Request> = {
    /**
     * The JSON-RPC ID of the request being handled.
     * This can be useful for tracking or logging purposes.
     */
    id: RequestId;
    /**
     * The method of the request.
     */
    method: string;
    /**
     * The metadata of the request.
     */
    _meta?: RequestMeta;
    /**
     * An abort signal used to communicate if the request was cancelled.
     */
    signal: AbortSignal;
    /**
     * Sends a request that relates to the current request being handled.
     * This is used by certain transports to correctly associate related messages.
     */
    send: <U extends AnySchema>(request: RequestT, resultSchema: U, options?: RequestOptions) => Promise<SchemaOutput<U>>;
};

export type McpReqContextInput = Omit<McpReqContext, 'send'>;

/**
 * Request context with authentication information and send method.
 */
export type HttpReqContext = {
    /**
     * The authentication information, if available.
     */
    authInfo?: AuthInfo;
};

/**
 * Notification context with send method.
 */
export type NotificationContext<NotificationT extends Notification = Notification> = {
    /**
     * Sends a notification that relates to the current request being handled.
     * This is used by certain transports to correctly associate related messages.
     */
    send: (notification: NotificationT) => Promise<void>;
};

/**
 * Base request context for internal construction args.
 * @internal
 */
export type BaseRequestContext = {
    signal: AbortSignal;
    authInfo?: AuthInfo;
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
 * Defines the common structure shared by both client and server contexts.
 *
 * @typeParam RequestT - The type of requests that can be sent from this context
 * @typeParam NotificationT - The type of notifications that can be sent from this context
 */
export interface ContextInterface<RequestT extends Request = Request, NotificationT extends Notification = Notification> {
    /**
     * The session ID of the request.
     */
    sessionId?: string;

    /**
     * MCP request context containing protocol-level information.
     */
    mcpReq: McpReqContext<RequestT>;

    /**
     * HTTP request context with authentication and send method.
     */
    http?: HttpReqContext;

    /**
     * Task context if this is a task-augmented request, undefined otherwise.
     */
    task: TaskContext | undefined;

    /**
     * Notification context with send method.
     */
    notification: NotificationContext<NotificationT>;
}

/**
 * Abstract base class for context objects passed to request handlers.
 * Provides shared implementation with structured nested objects.
 *
 * @typeParam RequestT - The type of requests that can be sent from this context
 * @typeParam NotificationT - The type of notifications that can be sent from this context
 * @typeParam RequestContextT - The type of request context (server or client specific)
 */
export abstract class BaseContext<
    RequestT extends Request = Request,
    NotificationT extends Notification = Notification,
    ResultT extends Result = Result
> implements ContextInterface<RequestT, NotificationT>
{
    /**
     * The session ID of the request.
     */
    public readonly sessionId?: string;

    /**
     * MCP request context containing protocol-level information.
     */
    public readonly mcpReq: McpReqContext<RequestT>;

    /**
     * HTTP request context with authentication and send method.
     */
    public readonly http?: HttpReqContext;

    /**
     * Task context if this is a task-augmented request, undefined otherwise.
     */
    public readonly task: TaskContext | undefined;

    /**
     * Notification context with send method.
     */
    public readonly notification: NotificationContext<NotificationT>;

    /**
     * Returns the protocol instance for sending notifications and requests.
     * Subclasses must implement this to provide the appropriate Client or Server instance.
     */
    protected abstract getProtocol(): Protocol<RequestT, NotificationT, ResultT>;

    /**
     * Sends a request that relates to the current request being handled.
     * This is used by certain transports to correctly associate related messages.
     */
    protected async _sendRequest<U extends AnySchema>(
        request: RequestT,
        resultSchema: U,
        options?: RequestOptions
    ): Promise<SchemaOutput<U>> {
        const requestOptions: RequestOptions = { ...options, relatedRequestId: this.mcpReq.id };

        // Only set relatedTask if there's a valid (non-empty) task ID
        const taskId = this.task?.id;
        if (taskId) {
            requestOptions.relatedTask = { taskId };

            // Set task status to input_required when sending a request within a task context
            if (this.task?.store) {
                await this.task.store.updateTaskStatus(taskId, 'input_required');
            }
        }

        return await this.getProtocol().request(request, resultSchema, requestOptions);
    }

    /**
     * Sends a notification that relates to the current request being handled.
     * This is used by certain transports to correctly associate related messages.
     */
    protected async _sendNotification(notification: NotificationT): Promise<void> {
        const notificationOptions: NotificationOptions = { relatedRequestId: this.mcpReq.id };

        // Only set relatedTask if there's a valid (non-empty) task ID
        if (this.task && this.task.id) {
            notificationOptions.relatedTask = { taskId: this.task.id };
        }

        return this.getProtocol().notification(notification, notificationOptions);
    }

    constructor(args: {
        request: JSONRPCRequest;
        sessionId?: string;
        http?: HttpReqContext;
        task: TaskContext | undefined;
        mcpReq: McpReqContextInput;
    }) {
        this.sessionId = args.sessionId;

        this.mcpReq = {
            ...args.mcpReq,
            send: this._sendRequest.bind(this)
        };

        // Use the task object directly instead of copying to preserve any getters
        // (e.g., the id getter that updates after createTask is called)
        this.task = args.task;

        // Create req context with bound send method
        this.http = args.http;
        // Create notification context with bound send method
        this.notification = {
            send: this._sendNotification.bind(this)
        };
    }
}
