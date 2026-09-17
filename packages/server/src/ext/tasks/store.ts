/**
 * The store interface of the Tasks extension: what the `tasks/*` request handlers
 * and `TasksExtension.create` call. Everything here is request/response over
 * JSON. How a task's work is executed — in-process, on a queue, in a
 * durable-execution runtime — is the server's business, not the SDK's: the
 * SDK only cares that a task can be created, read, answered, and cancelled.
 */

import type { InputResponses } from '@modelcontextprotocol/core-internal';
import type { DetailedTask, Task } from '@modelcontextprotocol/core-internal/ext/tasks';

/** What `TasksExtension.create` asks a store to durably create. */
export interface CreateTaskParams {
    /** Retention from creation, ms; `null` = unlimited. */
    ttlMs: number | null;
    /** Suggested client polling interval, ms; omitted = no hint on the task. */
    pollIntervalMs?: number;
    /**
     * Auth binding: the principal the creating request was authenticated as,
     * when the transport knows one. Stores MUST refuse `tasks/*` access from
     * a different principal (fail closed, no existence leak) and MAY ignore
     * it when absent.
     */
    principal?: string;
    /**
     * Free-form, store-defined. The originating tool name and arguments, a
     * workflow id — whatever the server's execution needs to find or start
     * the work. Opaque to the SDK.
     */
    context?: Record<string, unknown>;
}

/** The caller identity presented on a `tasks/*` request. */
export interface TaskAccess {
    principal?: string;
}

/**
 * A task store. Engine selection is configuration: the extension and the
 * tool handlers that create tasks are byte-identical across stores.
 *
 * - `create` MUST NOT resolve before a subsequent `get(taskId)` would succeed
 *   (durable creation, a Tasks extension rule).
 * - `get`, `update`, `cancel` resolve `undefined` / `false` for an unknown,
 *   expired, or foreign-principal task; the extension answers `-32602`.
 * - `cancel` is cooperative: it resolves on acknowledgement, the task may
 *   still settle `completed` or `failed`. Idempotent on terminal tasks.
 */
export interface TaskStore {
    create(params: CreateTaskParams): Promise<Task>;
    get(taskId: string, access?: TaskAccess): Promise<DetailedTask | undefined>;
    update(taskId: string, inputResponses: InputResponses, access?: TaskAccess): Promise<boolean>;
    cancel(taskId: string, access?: TaskAccess): Promise<boolean>;
}
