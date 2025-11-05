import { Task, TaskMetadata, Request, RequestId, Result } from '../types.js';

/**
 * Interface for storing and retrieving task state and results.
 *
 * Similar to Transport, this allows pluggable task storage implementations
 * (in-memory, database, distributed cache, etc.).
 */
export interface TaskStore {
    /**
     * Creates a new task with the given metadata and original request.
     *
     * @param task - The task creation metadata from the request
     * @param requestId - The JSON-RPC request ID
     * @param request - The original request that triggered task creation
     * @param sessionId - Optional session ID for binding the task to a specific session
     */
    createTask(task: TaskMetadata, requestId: RequestId, request: Request, sessionId?: string): Promise<void>;

    /**
     * Gets the current status of a task.
     *
     * @param taskId - The task identifier
     * @param sessionId - Optional session ID for binding the query to a specific session
     * @returns The task state including status, keepAlive, pollFrequency, and optional error
     */
    getTask(taskId: string, sessionId?: string): Promise<Task | null>;

    /**
     * Stores the result of a completed task.
     *
     * @param taskId - The task identifier
     * @param result - The result to store
     * @param sessionId - Optional session ID for binding the operation to a specific session
     */
    storeTaskResult(taskId: string, result: Result, sessionId?: string): Promise<void>;

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
     * @param error - Optional error message if status is 'failed' or 'cancelled'
     * @param sessionId - Optional session ID for binding the operation to a specific session
     */
    updateTaskStatus(taskId: string, status: Task['status'], error?: string, sessionId?: string): Promise<void>;

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
 * @returns True if the status is terminal (completed, failed, cancelled, or unknown)
 */
export function isTerminal(status: Task['status']): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'unknown';
}
