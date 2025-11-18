import { Task, TaskCreationParams, Request, RequestId, Result } from '../../types.js';
import { TaskStore, isTerminal } from '../../shared/task.js';
import { randomBytes } from 'crypto';

interface StoredTask {
    task: Task;
    request: Request;
    requestId: RequestId;
    result?: Result;
}

/**
 * A simple in-memory implementation of TaskStore for demonstration purposes.
 *
 * This implementation stores all tasks in memory and provides automatic cleanup
 * based on the ttl duration specified in the task creation parameters.
 *
 * Note: This is not suitable for production use as all data is lost on restart.
 * For production, consider implementing TaskStore with a database or distributed cache.
 */
export class InMemoryTaskStore implements TaskStore {
    private tasks = new Map<string, StoredTask>();
    private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

    /**
     * Generates a unique task ID.
     * Uses 16 bytes of random data encoded as hex (32 characters).
     */
    private generateTaskId(): string {
        return randomBytes(16).toString('hex');
    }

    async createTask(taskParams: TaskCreationParams, requestId: RequestId, request: Request, _sessionId?: string): Promise<Task> {
        // Generate a unique task ID
        const taskId = this.generateTaskId();

        // Ensure uniqueness
        if (this.tasks.has(taskId)) {
            throw new Error(`Task with ID ${taskId} already exists`);
        }

        // Create task with generated ID and timestamp
        const task: Task = {
            taskId,
            status: 'working',
            ttl: taskParams.ttl ?? null,
            createdAt: new Date().toISOString(),
            pollInterval: taskParams.pollInterval ?? 500
        };

        this.tasks.set(taskId, {
            task,
            request,
            requestId
        });

        // Schedule cleanup if ttl is specified
        if (taskParams.ttl) {
            const timer = setTimeout(() => {
                this.tasks.delete(taskId);
                this.cleanupTimers.delete(taskId);
            }, taskParams.ttl);

            this.cleanupTimers.set(taskId, timer);
        }

        return task;
    }

    async getTask(taskId: string, _sessionId?: string): Promise<Task | null> {
        const stored = this.tasks.get(taskId);
        return stored ? { ...stored.task } : null;
    }

    async storeTaskResult(taskId: string, result: Result, _sessionId?: string): Promise<void> {
        const stored = this.tasks.get(taskId);
        if (!stored) {
            throw new Error(`Task with ID ${taskId} not found`);
        }

        stored.result = result;
        stored.task.status = 'completed';

        // Reset cleanup timer to start from now (if ttl is set)
        if (stored.task.ttl) {
            const existingTimer = this.cleanupTimers.get(taskId);
            if (existingTimer) {
                clearTimeout(existingTimer);
            }

            const timer = setTimeout(() => {
                this.tasks.delete(taskId);
                this.cleanupTimers.delete(taskId);
            }, stored.task.ttl);

            this.cleanupTimers.set(taskId, timer);
        }
    }

    async getTaskResult(taskId: string, _sessionId?: string): Promise<Result> {
        const stored = this.tasks.get(taskId);
        if (!stored) {
            throw new Error(`Task with ID ${taskId} not found`);
        }

        if (!stored.result) {
            throw new Error(`Task ${taskId} has no result stored`);
        }

        return stored.result;
    }

    async updateTaskStatus(taskId: string, status: Task['status'], statusMessage?: string, _sessionId?: string): Promise<void> {
        const stored = this.tasks.get(taskId);
        if (!stored) {
            throw new Error(`Task with ID ${taskId} not found`);
        }

        stored.task.status = status;
        if (statusMessage) {
            stored.task.statusMessage = statusMessage;
        }

        // If task is in a terminal state and has ttl, start cleanup timer
        if (isTerminal(status) && stored.task.ttl) {
            const existingTimer = this.cleanupTimers.get(taskId);
            if (existingTimer) {
                clearTimeout(existingTimer);
            }

            const timer = setTimeout(() => {
                this.tasks.delete(taskId);
                this.cleanupTimers.delete(taskId);
            }, stored.task.ttl);

            this.cleanupTimers.set(taskId, timer);
        }
    }

    async listTasks(cursor?: string, _sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
        const PAGE_SIZE = 10;
        const allTaskIds = Array.from(this.tasks.keys());

        let startIndex = 0;
        if (cursor) {
            const cursorIndex = allTaskIds.indexOf(cursor);
            if (cursorIndex >= 0) {
                startIndex = cursorIndex + 1;
            } else {
                // Invalid cursor - throw error
                throw new Error(`Invalid cursor: ${cursor}`);
            }
        }

        const pageTaskIds = allTaskIds.slice(startIndex, startIndex + PAGE_SIZE);
        const tasks = pageTaskIds.map(taskId => {
            const stored = this.tasks.get(taskId)!;
            return { ...stored.task };
        });

        const nextCursor = startIndex + PAGE_SIZE < allTaskIds.length ? pageTaskIds[pageTaskIds.length - 1] : undefined;

        return { tasks, nextCursor };
    }

    /**
     * Cleanup all timers (useful for testing or graceful shutdown)
     */
    cleanup(): void {
        for (const timer of this.cleanupTimers.values()) {
            clearTimeout(timer);
        }
        this.cleanupTimers.clear();
        this.tasks.clear();
    }

    /**
     * Get all tasks (useful for debugging)
     */
    getAllTasks(): Task[] {
        return Array.from(this.tasks.values()).map(stored => ({ ...stored.task }));
    }
}
