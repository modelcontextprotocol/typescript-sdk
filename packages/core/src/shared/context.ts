import type { CreateTaskOptions } from '../experimental/tasks/interfaces.js';
import type { AuthInfo, Notification, Request, RequestId, RequestMeta, Result, Task } from '../types/types.js';
import type { AnySchema, SchemaOutput } from '../util/zodCompat.js';
import type { RequestOptions } from './protocol.js';

/**
 * Request-scoped task store for managing task state within a handler.
 */
export interface RequestTaskStore {
    /**
     * Creates a new task with the given creation parameters.
     */
    createTask(taskParams: CreateTaskOptions): Promise<Task>;

    /**
     * Gets the current status of a task.
     */
    getTask(taskId: string): Promise<Task>;

    /**
     * Stores the result of a task and sets its final status.
     */
    storeTaskResult(taskId: string, status: 'completed' | 'failed', result: Result): Promise<void>;

    /**
     * Retrieves the stored result of a task.
     */
    getTaskResult(taskId: string): Promise<Result>;

    /**
     * Updates a task's status (e.g., to 'cancelled', 'failed', 'completed').
     */
    updateTaskStatus(taskId: string, status: Task['status'], statusMessage?: string): Promise<void>;

    /**
     * Lists tasks, optionally starting from a pagination cursor.
     */
    listTasks(cursor?: string): Promise<{ tasks: Task[]; nextCursor?: string }>;
}

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
    store: RequestTaskStore;
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
export type BaseContext<RequestT extends Request = Request, NotificationT extends Notification = Notification> = {
    /**
     * The session ID of the request.
     */
    sessionId?: string;

    /**
     * MCP request context containing protocol-level information.
     */
    mcpReq: {
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
     * HTTP request context with authentication information.
     */
    http?: {
        /**
         * The authentication information, if available.
         */
        authInfo?: AuthInfo;
    };

    /**
     * Task context if this is a task-augmented request, undefined otherwise.
     */
    task: TaskContext | undefined;

    /**
     * Notification context with send method.
     */
    notification: {
        /**
         * Sends a notification that relates to the current request being handled.
         * This is used by certain transports to correctly associate related messages.
         */
        send: (notification: NotificationT) => Promise<void>;
    };
};
