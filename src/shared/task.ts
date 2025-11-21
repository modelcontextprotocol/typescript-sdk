import { Task, TaskCreationParams, Request, RequestId, Result, JSONRPCRequest, JSONRPCNotification, JSONRPCResponse } from '../types.js';

/**
 * Represents a message queued for side-channel delivery via tasks/result.
 */
export interface QueuedMessage {
    /** Type of message */
    type: 'request' | 'notification';
    /** The actual JSONRPC message */
    message: JSONRPCRequest | JSONRPCNotification;
    /** When it was queued */
    timestamp: number;
    /** For requests: resolver to call when response is received */
    responseResolver?: (response: JSONRPCResponse | Error) => void;
    /** For requests: the original request ID for response routing */
    originalRequestId?: RequestId;
}

/**
 * Interface for managing per-task FIFO message queues.
 *
 * Similar to TaskStore, this allows pluggable queue implementations
 * (in-memory, Redis, other distributed queues, etc.) for server-initiated
 * messages that will be delivered through the tasks/result response stream.
 *
 * Each method accepts taskId and optional sessionId parameters to enable
 * a single queue instance to manage messages for multiple tasks, with
 * isolation based on task ID and session ID.
 *
 * All methods are async to support external storage implementations.
 *
 * Performance Notes:
 * - enqueue() atomically enforces maxSize to prevent race conditions
 * - dequeue() returns undefined when empty, eliminating need for isEmpty() checks
 * - dequeueAll() is used when tasks are cancelled/failed to reject pending resolvers
 */
export interface TaskMessageQueue {
    /**
     * Adds a message to the end of the queue for a specific task.
     * Atomically checks queue size and throws if maxSize would be exceeded.
     * @param taskId The task identifier
     * @param message The message to enqueue
     * @param sessionId Optional session ID for binding the operation to a specific session
     * @param maxSize Optional maximum queue size - if specified and queue is full, throws an error
     * @throws Error if maxSize is specified and would be exceeded
     */
    enqueue(taskId: string, message: QueuedMessage, sessionId?: string, maxSize?: number): Promise<void>;

    /**
     * Removes and returns the first message from the queue for a specific task.
     * @param taskId The task identifier
     * @param sessionId Optional session ID for binding the query to a specific session
     * @returns The first message, or undefined if the queue is empty
     */
    dequeue(taskId: string, sessionId?: string): Promise<QueuedMessage | undefined>;

    /**
     * Removes and returns all messages from the queue for a specific task.
     * Used when tasks are cancelled or failed to reject any pending request resolvers.
     * @param taskId The task identifier
     * @param sessionId Optional session ID for binding the query to a specific session
     * @returns Array of all messages that were in the queue
     */
    dequeueAll(taskId: string, sessionId?: string): Promise<QueuedMessage[]>;
}

/**
 * Interface for storing and retrieving task state and results.
 *
 * Similar to Transport, this allows pluggable task storage implementations
 * (in-memory, database, distributed cache, etc.).
 */
export interface TaskStore {
    /**
     * Creates a new task with the given creation parameters and original request.
     * The implementation must generate a unique taskId and createdAt timestamp.
     *
     * TTL Management:
     * - The implementation receives the TTL suggested by the requestor via taskParams.ttl
     * - The implementation MAY override the requested TTL (e.g., to enforce limits)
     * - The actual TTL used MUST be returned in the Task object
     * - Null TTL indicates unlimited task lifetime (no automatic cleanup)
     * - Cleanup SHOULD occur automatically after TTL expires, regardless of task status
     *
     * @param taskParams - The task creation parameters from the request (ttl, pollInterval)
     * @param requestId - The JSON-RPC request ID
     * @param request - The original request that triggered task creation
     * @param sessionId - Optional session ID for binding the task to a specific session
     * @returns The task state including generated taskId, createdAt timestamp, status, ttl, pollInterval, and optional statusMessage
     */
    createTask(taskParams: TaskCreationParams, requestId: RequestId, request: Request, sessionId?: string): Promise<Task>;

    /**
     * Gets the current status of a task.
     *
     * @param taskId - The task identifier
     * @param sessionId - Optional session ID for binding the query to a specific session
     * @returns The task state including status, ttl, pollInterval, and optional statusMessage
     */
    getTask(taskId: string, sessionId?: string): Promise<Task | null>;

    /**
     * Stores the result of a task and sets its final status.
     *
     * @param taskId - The task identifier
     * @param status - The final status: 'completed' for success, 'failed' for errors
     * @param result - The result to store
     * @param sessionId - Optional session ID for binding the operation to a specific session
     */
    storeTaskResult(taskId: string, status: 'completed' | 'failed', result: Result, sessionId?: string): Promise<void>;

    /**
     * Retrieves the stored result of a task.
     *
     * @param taskId - The task identifier
     * @param sessionId - Optional session ID for binding the query to a specific session
     * @returns The stored result
     */
    getTaskResult(taskId: string, sessionId?: string): Promise<Result>;

    /**
     * Updates a task's status (e.g., to 'cancelled', 'failed', 'completed').
     *
     * @param taskId - The task identifier
     * @param status - The new status
     * @param statusMessage - Optional diagnostic message for failed tasks or other status information
     * @param sessionId - Optional session ID for binding the operation to a specific session
     */
    updateTaskStatus(taskId: string, status: Task['status'], statusMessage?: string, sessionId?: string): Promise<void>;

    /**
     * Lists tasks, optionally starting from a pagination cursor.
     *
     * @param cursor - Optional cursor for pagination
     * @param sessionId - Optional session ID for binding the query to a specific session
     * @returns An object containing the tasks array and an optional nextCursor
     */
    listTasks(cursor?: string, sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }>;
}

/**
 * Checks if a task status represents a terminal state.
 * Terminal states are those where the task has finished and will not change.
 *
 * @param status - The task status to check
 * @returns True if the status is terminal (completed, failed, or cancelled)
 */
export function isTerminal(status: Task['status']): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
}
