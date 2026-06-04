/**
 * In-memory implementations of TaskStore and TaskMessageQueue.
 * WARNING: These APIs are experimental and may change without notice.
 *
 * @experimental
 */

import { Task, RequestId, Result, Request } from '../../../types.js';
import { TaskStore, isTerminal, TaskMessageQueue, QueuedMessage, CreateTaskOptions } from '../interfaces.js';
import { randomBytes } from 'node:crypto';

interface StoredTask {
    task: Task;
    request: Request;
    requestId: RequestId;
    sessionId?: string;
    result?: Result;
}

/**
 * Module-private sentinel granting unfiltered access to tasks across all
 * sessions. Deliberately not exported: external callers can only pass
 * `string | undefined` session ids, which always fail closed — `undefined`
 * matches only tasks created without a session id, so a call path that
 * fails to thread the session id can never gain cross-session access.
 */
const UNFILTERED_ACCESS = Symbol('InMemoryTaskStore.unfilteredAccess');

type SessionAccess = string | undefined | typeof UNFILTERED_ACCESS;

/**
 * A simple in-memory implementation of TaskStore for demonstration purposes.
 *
 * This implementation stores all tasks in memory and provides automatic cleanup
 * based on the ttl duration specified in the task creation parameters.
 *
 * Tasks are bound to the session that created them: a task is only visible to
 * callers presenting the exact sessionId recorded at creation time, and any
 * mismatch behaves exactly as if the task does not exist. The gate fails
 * closed — a caller that provides no sessionId can only see tasks created
 * without one, so a call path that fails to thread the session id can never
 * gain cross-session access. This means a single store instance can safely
 * back multiple sessions. Unfiltered access for debugging is available only
 * via getAllTasks().
 *
 * Sessionless deployments (stdio, stateless HTTP) share a single task
 * namespace by design: every task is created without a sessionId and is
 * visible to every sessionless caller. Unguessable task IDs (128-bit random)
 * protect direct tasks/get and tasks/result access, while tasks/list
 * enumerates within that namespace. Deployments that need per-principal
 * isolation in sessionless mode must enable session management or supply a
 * custom TaskStore implementation keyed on their verified identity —
 * TaskStore is the public, pluggable interface prescribed for that purpose.
 *
 * Mixing sessionless and session-scoped tasks in one store instance is the
 * signature of a session-threading bug upstream of the store; createTask
 * emits a one-time warning when it detects this.
 *
 * Note: This is not suitable for production use as all data is lost on restart.
 * For production, consider implementing TaskStore with a database or distributed cache.
 *
 * @experimental
 */
export class InMemoryTaskStore implements TaskStore {
    private tasks = new Map<string, StoredTask>();
    private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private warnedMixedSessionUsage = false;

    /**
     * Generates a unique task ID.
     * Uses 16 bytes of random data encoded as hex (32 characters).
     */
    private generateTaskId(): string {
        return randomBytes(16).toString('hex');
    }

    async createTask(taskParams: CreateTaskOptions, requestId: RequestId, request: Request, sessionId?: string): Promise<Task> {
        // Generate a unique task ID
        const taskId = this.generateTaskId();

        // Ensure uniqueness
        if (this.tasks.has(taskId)) {
            throw new Error(`Task with ID ${taskId} already exists`);
        }

        this.warnIfMixedSessionUsage(sessionId);

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
     * Emits a one-time warning when sessionless and session-scoped tasks are
     * mixed in the same store instance. That mix is the signature of a session
     * id not being threaded through a TaskStore call path somewhere upstream
     * of the store: the affected tasks silently land in (or read from) the
     * shared sessionless namespace instead of the caller's session.
     */
    private warnIfMixedSessionUsage(sessionId?: string): void {
        if (this.warnedMixedSessionUsage) {
            return;
        }
        for (const stored of this.tasks.values()) {
            if ((stored.sessionId === undefined) !== (sessionId === undefined)) {
                this.warnedMixedSessionUsage = true;
                // eslint-disable-next-line no-console
                console.warn(
                    'InMemoryTaskStore: this store now contains a mix of sessionless and session-scoped tasks. ' +
                        'This usually means a session id is not being threaded through every TaskStore call path. ' +
                        'Sessionless tasks are only visible to sessionless callers and vice versa, so the affected ' +
                        'tasks will appear to be missing for their creators.'
                );
                return;
            }
        }
    }

    /**
     * Decides whether a stored task is visible for the given access: either
     * the module-private unfiltered sentinel, or a caller-supplied session id
     * that must exactly equal the sessionId recorded at creation time
     * (undefined matches only tasks created without a session id).
     */
    private isVisible(stored: StoredTask, access: SessionAccess): boolean {
        return access === UNFILTERED_ACCESS || stored.sessionId === access;
    }

    /**
     * Looks up a stored task, enforcing session ownership.
     *
     * The task is only visible if the caller's sessionId equals the sessionId
     * recorded at creation time; callers without a sessionId only see tasks
     * created without one. On a mismatch this returns undefined, which callers
     * translate into the same not-found behavior used for unknown task IDs — a
     * cross-session probe cannot distinguish a foreign task from a nonexistent
     * one.
     */
    private getStoredTask(taskId: string, sessionId?: string): StoredTask | undefined {
        const stored = this.tasks.get(taskId);
        if (!stored || !this.isVisible(stored, sessionId)) {
            return undefined;
        }
        return stored;
    }

    async getTask(taskId: string, sessionId?: string): Promise<Task | null> {
        const stored = this.getStoredTask(taskId, sessionId);
        return stored ? { ...stored.task } : null;
    }

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

    async listTasks(cursor?: string, sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
        const PAGE_SIZE = 10;

        // Restrict the listing to the caller's session before paginating, so
        // cursors, page contents, and counts never observe foreign tasks.
        // Callers without a sessionId see only tasks created without one.
        const sessionTaskIds = Array.from(this.tasks.entries())
            .filter(([, stored]) => this.isVisible(stored, sessionId))
            .map(([taskId]) => taskId);

        let startIndex = 0;
        if (cursor) {
            const cursorIndex = sessionTaskIds.indexOf(cursor);
            if (cursorIndex >= 0) {
                startIndex = cursorIndex + 1;
            } else {
                // Invalid cursor - throw error
                throw new Error(`Invalid cursor: ${cursor}`);
            }
        }

        const pageTaskIds = sessionTaskIds.slice(startIndex, startIndex + PAGE_SIZE);
        const tasks = pageTaskIds.map(taskId => {
            const stored = this.tasks.get(taskId)!;
            return { ...stored.task };
        });

        const nextCursor = startIndex + PAGE_SIZE < sessionTaskIds.length ? pageTaskIds[pageTaskIds.length - 1] : undefined;

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
     * Get all tasks across all sessions (useful for debugging).
     *
     * This is the only unfiltered view of the store: it uses the
     * module-private sentinel, which cannot be passed through the public
     * sessionId parameters.
     */
    getAllTasks(): Task[] {
        return Array.from(this.tasks.values())
            .filter(stored => this.isVisible(stored, UNFILTERED_ACCESS))
            .map(stored => ({ ...stored.task }));
    }
}

/**
 * A simple in-memory implementation of TaskMessageQueue for demonstration purposes.
 *
 * This implementation stores messages in memory, organized by task ID and optional session ID.
 * Messages are stored in FIFO queues per task.
 *
 * Note: This is not suitable for production use in distributed systems.
 * For production, consider implementing TaskMessageQueue with Redis or other distributed queues.
 *
 * @experimental
 */
export class InMemoryTaskMessageQueue implements TaskMessageQueue {
    private queues = new Map<string, QueuedMessage[]>();

    /**
     * Generates a queue key from taskId.
     * SessionId is intentionally ignored because taskIds are globally unique
     * and tasks need to be accessible across HTTP requests/sessions.
     */
    private getQueueKey(taskId: string, _sessionId?: string): string {
        return taskId;
    }

    /**
     * Gets or creates a queue for the given task and session.
     */
    private getQueue(taskId: string, sessionId?: string): QueuedMessage[] {
        const key = this.getQueueKey(taskId, sessionId);
        let queue = this.queues.get(key);
        if (!queue) {
            queue = [];
            this.queues.set(key, queue);
        }
        return queue;
    }

    /**
     * Adds a message to the end of the queue for a specific task.
     * Atomically checks queue size and throws if maxSize would be exceeded.
     * @param taskId The task identifier
     * @param message The message to enqueue
     * @param sessionId Optional session ID for binding the operation to a specific session
     * @param maxSize Optional maximum queue size - if specified and queue is full, throws an error
     * @throws Error if maxSize is specified and would be exceeded
     */
    async enqueue(taskId: string, message: QueuedMessage, sessionId?: string, maxSize?: number): Promise<void> {
        const queue = this.getQueue(taskId, sessionId);

        // Atomically check size and enqueue
        if (maxSize !== undefined && queue.length >= maxSize) {
            throw new Error(`Task message queue overflow: queue size (${queue.length}) exceeds maximum (${maxSize})`);
        }

        queue.push(message);
    }

    /**
     * Removes and returns the first message from the queue for a specific task.
     * @param taskId The task identifier
     * @param sessionId Optional session ID for binding the query to a specific session
     * @returns The first message, or undefined if the queue is empty
     */
    async dequeue(taskId: string, sessionId?: string): Promise<QueuedMessage | undefined> {
        const queue = this.getQueue(taskId, sessionId);
        return queue.shift();
    }

    /**
     * Removes and returns all messages from the queue for a specific task.
     * @param taskId The task identifier
     * @param sessionId Optional session ID for binding the query to a specific session
     * @returns Array of all messages that were in the queue
     */
    async dequeueAll(taskId: string, sessionId?: string): Promise<QueuedMessage[]> {
        const key = this.getQueueKey(taskId, sessionId);
        const queue = this.queues.get(key) ?? [];
        this.queues.delete(key);
        return queue;
    }
}
