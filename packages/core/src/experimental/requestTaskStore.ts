import type { JSONRPCRequest, RequestId, Result, Task } from '../types/types.js';
import type { CreateTaskOptions, TaskStore } from './tasks/interfaces.js';

/**
 * Request-scoped TaskStore interface.
 */
export interface RequestTaskStoreInterface {
    /**
     * Creates a new task with the given creation parameters.
     * The implementation generates a unique taskId and createdAt timestamp.
     *
     * @param taskParams - The task creation parameters from the request
     * @returns The created task object
     */
    createTask(taskParams: CreateTaskOptions): Promise<Task>;

    /**
     * Gets the current status of a task.
     *
     * @param taskId - The task identifier
     * @returns The task object
     * @throws If the task does not exist
     */
    getTask(taskId: string): Promise<Task>;

    /**
     * Stores the result of a task and sets its final status.
     *
     * @param taskId - The task identifier
     * @param status - The final status: 'completed' for success, 'failed' for errors
     * @param result - The result to store
     */
    storeTaskResult(taskId: string, status: 'completed' | 'failed', result: Result): Promise<void>;

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
     * @param statusMessage - Optional diagnostic message for failed tasks or other status information
     */
    updateTaskStatus(taskId: string, status: Task['status'], statusMessage?: string): Promise<void>;

    /**
     * Lists tasks, optionally starting from a pagination cursor.
     *
     * @param cursor - Optional cursor for pagination
     * @returns An object containing the tasks array and an optional nextCursor
     */
    listTasks(cursor?: string): Promise<{ tasks: Task[]; nextCursor?: string }>;
}

/**
 * Request-scoped task store implementation that wraps a TaskStore with session binding
 * and provides a mutable task ID that updates after task creation.
 */
export class RequestTaskStore implements RequestTaskStoreInterface {
    private readonly _taskStore: TaskStore;
    private readonly _requestId: RequestId;
    private readonly _request: JSONRPCRequest;
    private readonly _sessionId: string | undefined;
    private readonly _taskIdHolder: { id: string };

    constructor(args: {
        taskStore: TaskStore;
        requestId: RequestId;
        request: JSONRPCRequest;
        sessionId: string | undefined;
        initialTaskId: string;
    }) {
        this._taskStore = args.taskStore;
        this._requestId = args.requestId;
        this._request = args.request;
        this._sessionId = args.sessionId;
        this._taskIdHolder = { id: args.initialTaskId };
    }

    /**
     * Gets the current task ID. This may be updated after createTask is called.
     */
    get currentTaskId(): string {
        return this._taskIdHolder.id;
    }

    async createTask(taskParams: CreateTaskOptions): Promise<Task> {
        const task = await this._taskStore.createTask(taskParams, this._requestId, this._request, this._sessionId);
        // Update the task ID so subsequent sendRequest/sendNotification calls
        // will use the correct task ID for message routing
        this._taskIdHolder.id = task.taskId;
        return task;
    }

    async getTask(taskId: string): Promise<Task> {
        const task = await this._taskStore.getTask(taskId, this._sessionId);
        if (!task) throw new Error(`Task not found: ${taskId}`);
        return task;
    }

    async storeTaskResult(taskId: string, status: 'completed' | 'failed', result: Result): Promise<void> {
        return this._taskStore.storeTaskResult(taskId, status, result, this._sessionId);
    }

    async getTaskResult(taskId: string): Promise<Result> {
        return this._taskStore.getTaskResult(taskId, this._sessionId);
    }

    async updateTaskStatus(taskId: string, status: Task['status'], statusMessage?: string): Promise<void> {
        return this._taskStore.updateTaskStatus(taskId, status, statusMessage, this._sessionId);
    }

    async listTasks(cursor?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
        return this._taskStore.listTasks(this._sessionId, cursor);
    }
}
