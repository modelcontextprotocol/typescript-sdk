/**
 * In-memory implementation of {@linkcode TaskStore}.
 * @experimental
 */

import type { Request, RequestId, Result, Task } from '../../../types/index.js';
import type { CreateTaskOptions, TaskStore } from '../interfaces.js';
import { isTerminal } from '../interfaces.js';

interface StoredTask {
    task: Task;
    request: Request;
    requestId: RequestId;
    sessionId?: string;
    result?: Result;
}

/**
 * In-memory {@linkcode TaskStore} implementation for development and testing.
 * For production, use a database or distributed cache.
 * @experimental
 */
export class InMemoryTaskStore implements TaskStore {
    private tasks = new Map<string, StoredTask>();
    private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

    /**
     * Generates a unique task ID using Web Crypto API.
     */
    private generateTaskId(): string {
        return crypto.randomUUID().replaceAll('-', '');
    }

    /** {@inheritDoc TaskStore.createTask} */
    async createTask(taskParams: CreateTaskOptions, requestId: RequestId, request: Request, sessionId?: string): Promise<Task> {
        // Generate a unique task ID
        const taskId = this.generateTaskId();

        // Ensure uniqueness
        if (this.tasks.has(taskId)) {
            throw new Error(`Task with ID ${taskId} already exists`);
        }

        const actualTtl = taskParams.ttl ?? null;

        // Create task with generated ID and timestamps
        const createdAt = new Date().toISOString();
        const task: Task = {
            taskId,
            status: 'working',
            ttl: actualTtl,
            createdAt,
            lastUpdatedAt: createdAt,
            pollInterval: taskParams.pollInterval ?? 1000
        };

        this.tasks.set(taskId, {
            task,
            request,
            requestId,
            sessionId
        });

        // Schedule cleanup if ttl is specified
        // Cleanup occurs regardless of task status
        if (actualTtl) {
            const timer = setTimeout(() => {
                this.tasks.delete(taskId);
                this.cleanupTimers.delete(taskId);
            }, actualTtl);

            this.cleanupTimers.set(taskId, timer);
        }

        return task;
    }

    /**
     * Retrieves a stored task, enforcing session ownership when a sessionId is provided.
     * Returns undefined if the task does not exist or belongs to a different session.
     */
    private getStoredTask(taskId: string, sessionId?: string): StoredTask | undefined {
        const stored = this.tasks.get(taskId);
        if (!stored) {
            return undefined;
        }
        // Enforce session isolation: if a sessionId is provided and the task
        // was created with a sessionId, they must match.
        if (sessionId !== undefined && stored.sessionId !== undefined && stored.sessionId !== sessionId) {
            return undefined;
        }
        return stored;
    }

    async getTask(taskId: string, sessionId?: string): Promise<Task | null> {
        const stored = this.getStoredTask(taskId, sessionId);
        return stored ? { ...stored.task } : null;
    }

    /** {@inheritDoc TaskStore.storeTaskResult} */
    async storeTaskResult(taskId: string, status: 'completed' | 'failed', result: Result, sessionId?: string): Promise<void> {
        const stored = this.getStoredTask(taskId, sessionId);
        if (!stored) {
            throw new Error(`Task with ID ${taskId} not found`);
        }

        // Don't allow storing results for tasks already in terminal state
        if (isTerminal(stored.task.status)) {
            throw new Error(
                `Cannot store result for task ${taskId} in terminal status '${stored.task.status}'. Task results can only be stored once.`
            );
        }

        stored.result = result;
        stored.task.status = status;
        stored.task.lastUpdatedAt = new Date().toISOString();

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

    /** {@inheritDoc TaskStore.getTaskResult} */
    async getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
        const stored = this.getStoredTask(taskId, sessionId);
        if (!stored) {
            throw new Error(`Task with ID ${taskId} not found`);
        }

        if (!stored.result) {
            throw new Error(`Task ${taskId} has no result stored`);
        }

        return stored.result;
    }

    /** {@inheritDoc TaskStore.updateTaskStatus} */
    async updateTaskStatus(taskId: string, status: Task['status'], statusMessage?: string, sessionId?: string): Promise<void> {
        const stored = this.getStoredTask(taskId, sessionId);
        if (!stored) {
            throw new Error(`Task with ID ${taskId} not found`);
        }

        // Don't allow transitions from terminal states
        if (isTerminal(stored.task.status)) {
            throw new Error(
                `Cannot update task ${taskId} from terminal status '${stored.task.status}' to '${status}'. Terminal states (completed, failed, cancelled) cannot transition to other states.`
            );
        }

        stored.task.status = status;
        if (statusMessage) {
            stored.task.statusMessage = statusMessage;
        }

        stored.task.lastUpdatedAt = new Date().toISOString();

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

    /** {@inheritDoc TaskStore.listTasks} */
    async listTasks(cursor?: string, sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
        const PAGE_SIZE = 10;

        // Filter tasks by session ownership before pagination
        const filteredTaskIds = [...this.tasks.entries()]
            .filter(([, stored]) => {
                if (sessionId === undefined || stored.sessionId === undefined) {
                    return true;
                }
                return stored.sessionId === sessionId;
            })
            .map(([taskId]) => taskId);

        let startIndex = 0;
        if (cursor) {
            const cursorIndex = filteredTaskIds.indexOf(cursor);
            if (cursorIndex === -1) {
                // Invalid cursor - throw error
                throw new Error(`Invalid cursor: ${cursor}`);
            } else {
                startIndex = cursorIndex + 1;
            }
        }

        const pageTaskIds = filteredTaskIds.slice(startIndex, startIndex + PAGE_SIZE);
        const tasks = pageTaskIds.map(taskId => {
            const stored = this.tasks.get(taskId)!;
            return { ...stored.task };
        });

        const nextCursor = startIndex + PAGE_SIZE < filteredTaskIds.length ? pageTaskIds.at(-1) : undefined;

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
        return [...this.tasks.values()].map(stored => ({ ...stored.task }));
    }
}
