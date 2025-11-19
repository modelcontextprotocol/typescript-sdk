import { Task, TaskCreationParams, Request, RequestId, Result } from '../types.js';

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
