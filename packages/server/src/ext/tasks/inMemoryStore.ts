/**
 * `InMemoryTaskStore` — the reference {@link TaskStore}: task records in a
 * `Map`, TTL purge on a timer, and a writer {@link TaskHandle} the server's
 * own execution uses to report progress, request input, and settle the task.
 * State does not survive the process; the shape of every method is the row
 * write a persistent store would make instead.
 */

import type { CallToolResult, InputRequests, InputResponses } from '@modelcontextprotocol/core-internal';
import type { DetailedTask, Task, TaskStatus } from '@modelcontextprotocol/core-internal/ext/tasks';

import type { CreateTaskParams, TaskAccess, TaskStore } from './store';

interface PendingInput {
    requests: InputRequests;
    responses: InputResponses;
    resolve: (responses: InputResponses) => void;
}

interface TaskRecord {
    taskId: string;
    principal?: string;
    context?: Record<string, unknown>;
    status: TaskStatus;
    statusMessage?: string;
    createdAt: number;
    lastUpdatedAt: number;
    ttlMs: number | null;
    pollIntervalMs?: number;
    result?: CallToolResult;
    error?: { code: number; message: string; data?: unknown };
    pendingInput?: PendingInput;
    abort: AbortController;
    ttlTimer?: ReturnType<typeof setTimeout>;
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'cancelled']);

/**
 * The writer side of a task, for the code that does the work. Obtained from
 * {@link InMemoryTaskStore.handle}; a persistent store exposes its own
 * equivalent (or none, when the work reports through the store directly).
 */
export interface TaskHandle {
    readonly taskId: string;
    /** Aborted when `tasks/cancel` is acknowledged. */
    readonly signal: AbortSignal;
    /** Writes `statusMessage` for pollers. */
    status(message: string): Promise<void>;
    /**
     * Moves the task to `input_required` with `requests` outstanding and
     * resolves once `tasks/update` has answered every key (partial updates
     * accumulate). Rejects if the task is cancelled while waiting.
     */
    requireInput(requests: InputRequests): Promise<InputResponses>;
    complete(result: CallToolResult): Promise<void>;
    fail(error: { code: number; message: string; data?: unknown }): Promise<void>;
}

/** Options for {@link InMemoryTaskStore}. */
export interface InMemoryTaskStoreOptions {
    /** Task id factory. Default `crypto.randomUUID()`. */
    createTaskId?: () => string;
    /** Clock, for tests. Default `Date.now`. */
    now?: () => number;
}

export class InMemoryTaskStore implements TaskStore {
    readonly #tasks = new Map<string, TaskRecord>();
    readonly #createTaskId: () => string;
    readonly #now: () => number;

    constructor(options?: InMemoryTaskStoreOptions) {
        this.#createTaskId = options?.createTaskId ?? (() => crypto.randomUUID());
        this.#now = options?.now ?? (() => Date.now());
    }

    /** Clears every timer and forgets every task. For tests and shutdown. */
    close(): void {
        for (const record of this.#tasks.values()) {
            if (record.ttlTimer !== undefined) clearTimeout(record.ttlTimer);
            record.abort.abort();
        }
        this.#tasks.clear();
    }

    async create(params: CreateTaskParams): Promise<Task> {
        if (params.ttlMs !== null && (!Number.isSafeInteger(params.ttlMs) || params.ttlMs < 0)) {
            throw new RangeError(`ttlMs must be a non-negative integer or null, got ${params.ttlMs}`);
        }
        if (params.pollIntervalMs !== undefined && (!Number.isSafeInteger(params.pollIntervalMs) || params.pollIntervalMs < 0)) {
            throw new RangeError(`pollIntervalMs must be a non-negative integer, got ${params.pollIntervalMs}`);
        }
        const now = this.#now();
        const record: TaskRecord = {
            taskId: this.#createTaskId(),
            ...(params.principal !== undefined && { principal: params.principal }),
            ...(params.context !== undefined && { context: params.context }),
            status: 'working',
            createdAt: now,
            lastUpdatedAt: now,
            ttlMs: params.ttlMs,
            ...(params.pollIntervalMs !== undefined && { pollIntervalMs: params.pollIntervalMs }),
            abort: new AbortController()
        };
        if (record.ttlMs !== null) {
            record.ttlTimer = setTimeout(() => this.#purge(record), record.ttlMs);
            record.ttlTimer.unref?.();
        }
        this.#tasks.set(record.taskId, record);
        return this.#snapshot(record);
    }

    async get(taskId: string, access?: TaskAccess): Promise<DetailedTask | undefined> {
        const record = this.#lookup(taskId, access);
        return record === undefined ? undefined : this.#detailed(record);
    }

    async update(taskId: string, inputResponses: InputResponses, access?: TaskAccess): Promise<boolean> {
        const record = this.#lookup(taskId, access);
        if (record === undefined) return false;
        const pending = record.pendingInput;
        if (pending === undefined || TERMINAL.has(record.status)) return true;
        for (const [key, response] of Object.entries(inputResponses)) {
            // Unknown keys are ignored; the first answer to a key wins.
            if (key in pending.requests && !(key in pending.responses)) pending.responses[key] = response;
        }
        this.#touch(record);
        if (Object.keys(pending.requests).every(key => key in pending.responses)) {
            record.pendingInput = undefined;
            record.status = 'working';
            pending.resolve(pending.responses);
        }
        return true;
    }

    async cancel(taskId: string, access?: TaskAccess): Promise<boolean> {
        const record = this.#lookup(taskId, access);
        if (record === undefined) return false;
        if (TERMINAL.has(record.status)) return true;
        record.status = 'cancelled';
        record.pendingInput = undefined;
        this.#touch(record);
        record.abort.abort();
        return true;
    }

    /** The context recorded at creation, for the server's execution to pick the work up. */
    context(taskId: string): Record<string, unknown> | undefined {
        return this.#tasks.get(taskId)?.context;
    }

    /** The writer handle for a task the store holds. Throws for an unknown task. */
    handle(taskId: string): TaskHandle {
        const record = this.#tasks.get(taskId);
        if (record === undefined) throw new Error(`Task "${taskId}" not found`);
        const live = (): TaskRecord | undefined => {
            const current = this.#tasks.get(taskId);
            return current === undefined || TERMINAL.has(current.status) ? undefined : current;
        };
        return {
            taskId,
            signal: record.abort.signal,
            status: async message => {
                const current = live();
                if (current === undefined) return;
                current.statusMessage = message;
                this.#touch(current);
            },
            requireInput: requests => {
                const current = live();
                if (current === undefined) return Promise.reject(new Error(`Task "${taskId}" is no longer running`));
                return new Promise<InputResponses>((resolve, reject) => {
                    current.pendingInput = { requests, responses: {}, resolve };
                    current.status = 'input_required';
                    this.#touch(current);
                    current.abort.signal.addEventListener('abort', () => reject(new Error(`Task "${taskId}" was cancelled`)), {
                        once: true
                    });
                });
            },
            complete: async result => {
                const current = live();
                if (current === undefined) return;
                current.status = 'completed';
                current.result = result;
                this.#touch(current);
            },
            fail: async error => {
                const current = live();
                if (current === undefined) return;
                current.status = 'failed';
                current.error = error;
                this.#touch(current);
            }
        };
    }

    // ------------------------------------------------------------- internals --

    #lookup(taskId: string, access: TaskAccess | undefined): TaskRecord | undefined {
        const record = this.#tasks.get(taskId);
        if (record === undefined) return undefined;
        if (record.principal !== undefined && record.principal !== access?.principal) return undefined;
        return record;
    }

    #touch(record: TaskRecord): void {
        record.lastUpdatedAt = this.#now();
    }

    #purge(record: TaskRecord): void {
        record.abort.abort();
        this.#tasks.delete(record.taskId);
    }

    #snapshot(record: TaskRecord): Task {
        return {
            taskId: record.taskId,
            status: record.status,
            ...(record.statusMessage !== undefined && { statusMessage: record.statusMessage }),
            createdAt: new Date(record.createdAt).toISOString(),
            lastUpdatedAt: new Date(record.lastUpdatedAt).toISOString(),
            ttlMs: record.ttlMs,
            ...(record.pollIntervalMs !== undefined && { pollIntervalMs: record.pollIntervalMs })
        };
    }

    #detailed(record: TaskRecord): DetailedTask {
        const base = this.#snapshot(record);
        switch (record.status) {
            case 'working': {
                return { ...base, status: 'working' };
            }
            case 'input_required': {
                const pending = record.pendingInput;
                const inputRequests: InputRequests = {};
                for (const [key, request] of Object.entries(pending?.requests ?? {})) {
                    if (!(key in (pending?.responses ?? {}))) inputRequests[key] = request;
                }
                return { ...base, status: 'input_required', inputRequests };
            }
            case 'completed': {
                return { ...base, status: 'completed', result: (record.result ?? { content: [] }) as { [key: string]: unknown } };
            }
            case 'failed': {
                return { ...base, status: 'failed', error: record.error ?? { code: -32_603, message: 'Task failed' } };
            }
            case 'cancelled': {
                return { ...base, status: 'cancelled' };
            }
        }
    }
}
