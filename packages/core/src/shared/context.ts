import type { RequestTaskStoreInterface } from '../experimental/requestTaskStore.js';
import type { AuthInfo, JSONRPCRequest, Notification, Request, RequestId, RequestMeta, Result } from '../types/types.js';
import type { AnySchema, SchemaOutput } from '../util/zodCompat.js';
import type { NotificationOptions, Protocol, RequestOptions } from './protocol.js';

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
> {
    /**
     * The session ID of the request.
     */
    public readonly sessionId?: string;

    /**
     * MCP request context containing protocol-level information.
     * Includes request ID, method, metadata, and abort signal.
     */
    public readonly mcpReq: {
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

    /**
     * HTTP request context with authentication and send method.
     */
    public readonly http?: {
        /**
         * The authentication information, if available.
         */
        authInfo?: AuthInfo;
    };

    /**
     * Task context if this is a task-augmented request, undefined otherwise.
     */
    public readonly task:
        | {
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
          }
        | undefined;

    /**
     * Notification context with send method.
     */
    public readonly notification: {
        /**
         * Notification context with send method.
         */
        send: (notification: NotificationT) => Promise<void>;
    };

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
        http?: BaseContext<RequestT, NotificationT, ResultT>['http'];
        task: BaseContext<RequestT, NotificationT, ResultT>['task'];
        mcpReq: Omit<BaseContext<RequestT, NotificationT, ResultT>['mcpReq'], 'send'>;
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
