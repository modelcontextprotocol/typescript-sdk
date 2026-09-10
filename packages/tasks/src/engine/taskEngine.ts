/**
 * The control seam: what the `tasks/*` request handlers and the task tool's
 * `tools/call` handler call. Everything here is request/response over JSON,
 * so any execution engine — in-process timers, a database plus a worker
 * pool, a durable-execution runtime — can satisfy it. Engines never see wire
 * shapes beyond the `DetailedTask` snapshot they return.
 */

import type { InputResponses } from '@modelcontextprotocol/server';

import type { DetailedTask, Task } from '../wire/types';
import type { TaskExecutor } from './protocol';

/** What the tool handler asks an engine to durably create and schedule. */
export interface CreateTaskParams {
    /** The registered task name (the tool name). */
    taskName: string;
    /** Schema-validated tool arguments. */
    input: unknown;
    /** Retention from creation, ms; `null` = unlimited. */
    ttlMs: number | null;
    /** Suggested client polling interval, ms. */
    pollIntervalMs: number;
    /**
     * Opportunistic auth binding: the principal the creating request was
     * authenticated as, when the transport knows one. Engines MUST refuse
     * `tasks/*` access from a different principal (fail closed, no existence
     * leak) and MAY ignore it when absent.
     */
    principal?: string;
}

/** The caller identity presented on a `tasks/*` request. */
export interface TaskAccess {
    principal?: string;
}

/**
 * A task execution engine. Engine selection is configuration: handler
 * bodies and `registerTask` calls are byte-identical across engines.
 *
 * - `create` MUST NOT resolve before a subsequent `get(taskId)` would succeed
 *   (durable creation, a Tasks extension rule).
 * - `get`, `update`, `cancel` resolve `undefined` / `false` for an unknown,
 *   expired, or foreign-principal task; the caller answers `-32602`.
 * - `cancel` is cooperative: it resolves on acknowledgement, the task may
 *   still settle `completed` or `failed`. Idempotent on terminal tasks.
 */
export interface TaskEngine {
    create(params: CreateTaskParams): Promise<Task>;
    get(taskId: string, access?: TaskAccess): Promise<DetailedTask | undefined>;
    update(taskId: string, inputResponses: InputResponses, access?: TaskAccess): Promise<boolean>;
    cancel(taskId: string, access?: TaskAccess): Promise<boolean>;
    /**
     * Engines that run handlers in the same process receive the executor
     * here when the tasks are installed on a server. Engines whose handlers
     * run elsewhere (a separate worker, another runtime) omit it and build
     * their own executor from the same registrations.
     */
    attach?(executor: TaskExecutor): void;
}
