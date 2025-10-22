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
     */
    createTask(task: TaskMetadata, requestId: RequestId, request: Request): Promise<void>;

    /**
     * Gets the current status of a task.
     *
     * @param taskId - The task identifier
     * @returns The task state including status, keepAlive, pollFrequency, and optional error
     */
    getTask(taskId: string): Promise<Task | null>;

    /**
     * Stores the result of a completed task.
     *
     * @param taskId - The task identifier
     * @param result - The result to store
     */
    storeTaskResult(taskId: string, result: Result): Promise<void>;

    /**
     * Retrieves the stored result of a task.
     *
     * @param taskId - The task identifier
     * @returns The stored result
     */
    getTaskResult(taskId: string): Promise<Result>;

    /**
     * Updates a task's status (e.g., to 'cancelled', 'failed', 'completed').
     *
     * @param taskId - The task identifier
     * @param status - The new status
     * @param error - Optional error message if status is 'failed' or 'cancelled'
     */
    updateTaskStatus(taskId: string, status: Task['status'], error?: string): Promise<void>;
}
