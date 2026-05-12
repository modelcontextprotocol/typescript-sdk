/**
 * SEP-2663 Tasks extension plugin.
 *
 * Tasks attach via {@linkcode Dispatcher.use}; core (Dispatcher / StreamDriver /
 * Protocol / McpServer / Client) carries no task-specific code paths. The model
 * is server-directed: a tool handler decides to return `{resultType: 'task', task}`
 * itself; the SDK does not intercept or rewrite results.
 *
 * @experimental
 */

import type { BaseContext, RequestEnv, RequestOptions } from '../../shared/context.js';
import type { DispatchFn, DispatchMiddleware } from '../../shared/dispatcher.js';
import type { GetTaskResult, JSONRPCRequest, Notification, Request, Result, Task, TaskStatusNotification } from '../../types/index.js';
import { ProtocolError, ProtocolErrorCode, RELATED_TASK_META_KEY, TaskStatusNotificationSchema } from '../../types/index.js';
import type { StandardSchemaV1 } from '../../util/standardSchema.js';
import { validateStandardSchema } from '../../util/standardSchema.js';
import type { CreateTaskOptions, TaskStore } from './interfaces.js';
import { isTerminal } from './interfaces.js';

/**
 * Request-scoped view of a {@linkcode TaskStore} that binds `sessionId` and the
 * originating `JSONRPCRequest`, so handlers see a simpler `(taskId)` surface.
 */
export interface RequestTaskStore {
    createTask(taskParams: CreateTaskOptions): Promise<Task>;
    getTask(taskId: string): Promise<Task>;
    storeTaskResult(taskId: string, status: 'completed' | 'failed', result: Result): Promise<void>;
    getTaskResult(taskId: string): Promise<Result>;
    updateTaskStatus(taskId: string, status: Task['status'], statusMessage?: string): Promise<void>;
    listTasks(cursor?: string): Promise<{ tasks: Task[]; nextCursor?: string }>;
}

/**
 * Value placed at `ctx.ext.task` by {@linkcode tasksPlugin}. Handlers cast
 * `ctx.ext?.task as TaskContext` to read it.
 */
export type TaskContext = {
    /** Task id when this request carries `_meta['io.mcp/related-task'].taskId`. */
    id?: string;
    store: RequestTaskStore;
    /** TTL the client requested in `params.task.ttl`, when present. */
    requestedTtl?: number;
};

/** Reverse-DNS `ext` key {@linkcode tasksPlugin} writes to (per the {@linkcode BaseContext.ext} convention). */
export const TASK_EXT_KEY = 'io.modelcontextprotocol/task';

/** Read the {@linkcode TaskContext} {@linkcode tasksPlugin} placed on `ctx.ext`. */
export function taskContext(ctx: BaseContext): TaskContext | undefined {
    return ctx.ext?.[TASK_EXT_KEY] as TaskContext | undefined;
}

export interface TasksPluginOptions {
    store: TaskStore;
    /** Called when a task transitions status, so the host can broadcast `notifications/tasks/status`. */
    notify?: (notification: Notification) => Promise<void>;
}

/**
 * Returns a {@linkcode DispatchMiddleware} that registers `tasks/get`/`tasks/list`/
 * `tasks/cancel`/`tasks/result` handlers and injects `env.ext.task` for every
 * dispatched request. Register with `dispatcher.use(tasksPlugin({store}))`.
 */
export function tasksPlugin(opts: TasksPluginOptions): DispatchMiddleware {
    const { store, notify } = opts;

    const requestStore = (request: JSONRPCRequest, sessionId: string | undefined): RequestTaskStore => ({
        createTask: params => store.createTask(params, request.id, { method: request.method, params: request.params }, sessionId),
        getTask: async taskId => {
            const t = await store.getTask(taskId, sessionId);
            if (!t) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Task not found: ${taskId}`);
            return t;
        },
        storeTaskResult: async (taskId, status, result) => {
            await store.storeTaskResult(taskId, status, result, sessionId);
            const t = await store.getTask(taskId, sessionId);
            if (t && notify) {
                const n: TaskStatusNotification = TaskStatusNotificationSchema.parse({
                    method: 'notifications/tasks/status',
                    params: t
                });
                await notify(n as Notification);
            }
        },
        getTaskResult: taskId => store.getTaskResult(taskId, sessionId),
        updateTaskStatus: async (taskId, status, msg) => {
            const t = await store.getTask(taskId, sessionId);
            if (!t) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Task not found: ${taskId}`);
            if (isTerminal(t.status)) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Cannot update terminal task ${taskId} (${t.status})`);
            }
            await store.updateTaskStatus(taskId, status, msg, sessionId);
            const u = await store.getTask(taskId, sessionId);
            if (u && notify) {
                const n: TaskStatusNotification = TaskStatusNotificationSchema.parse({
                    method: 'notifications/tasks/status',
                    params: u
                });
                await notify(n as Notification);
            }
        },
        listTasks: cursor => store.listTasks(cursor, sessionId)
    });

    const handlers: Record<string, (params: Record<string, unknown>, ctx: BaseContext) => Promise<Result>> = {
        'tasks/get': async (params, ctx) => {
            const t = await store.getTask(params.taskId as string, ctx.sessionId);
            if (!t) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Task not found: ${params.taskId as string}`);
            return { ...t } as Result;
        },
        'tasks/result': async (params, ctx) => {
            const taskId = params.taskId as string;
            const t = await store.getTask(taskId, ctx.sessionId);
            if (!t) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Task not found: ${taskId}`);
            if (!isTerminal(t.status)) {
                throw new ProtocolError(ProtocolErrorCode.InvalidRequest, `Task ${taskId} is not terminal (status: ${t.status})`);
            }
            if (t.status === 'cancelled') {
                throw new ProtocolError(ProtocolErrorCode.InvalidRequest, `Task ${taskId} was cancelled; no result available`);
            }
            const result = await store.getTaskResult(taskId, ctx.sessionId);
            return { ...result, _meta: { ...result._meta, [RELATED_TASK_META_KEY]: { taskId } } };
        },
        'tasks/list': async (params, ctx) => {
            const { tasks, nextCursor } = await store.listTasks(params?.cursor as string | undefined, ctx.sessionId);
            return { tasks, nextCursor, _meta: {} } as Result;
        },
        'tasks/cancel': async (params, ctx) => {
            const taskId = params.taskId as string;
            const t = await store.getTask(taskId, ctx.sessionId);
            if (!t) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Task not found: ${taskId}`);
            if (isTerminal(t.status)) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Cannot cancel terminal task: ${t.status}`);
            }
            await store.updateTaskStatus(taskId, 'cancelled', 'Client cancelled task execution.', ctx.sessionId);
            const cancelled = (await store.getTask(taskId, ctx.sessionId)) ?? { ...t, status: 'cancelled' as const };
            if (notify) {
                const n: TaskStatusNotification = TaskStatusNotificationSchema.parse({
                    method: 'notifications/tasks/status',
                    params: cancelled
                });
                await notify(n as Notification);
            }
            return { _meta: {}, ...cancelled } as Result;
        }
    };

    return (next: DispatchFn): DispatchFn =>
        async function* (request, env) {
            const meta = request.params?._meta as Record<string, { taskId?: string }> | undefined;
            const relatedTaskId = meta?.[RELATED_TASK_META_KEY]?.taskId;
            const taskParams = (request.params as { task?: { ttl?: number } } | undefined)?.task;
            const taskCtx: TaskContext = {
                id: relatedTaskId,
                store: requestStore(request, env?.sessionId),
                requestedTtl: taskParams?.ttl
            };
            const nextEnv: RequestEnv = { ...env, ext: { ...env?.ext, [TASK_EXT_KEY]: taskCtx } };

            const own = handlers[request.method];
            if (own) {
                // The plugin's `tasks/*` handlers only read `ctx.sessionId`; we still build a
                // complete BaseContext (no `as` cast) so the contract holds if a handler later
                // calls `ctx.mcpReq.send`/`notify`. Those throw a clear unsupported-path error
                // instead of being undefined.
                const unsupported = () =>
                    Promise.reject(
                        new ProtocolError(
                            ProtocolErrorCode.InternalError,
                            'ctx.mcpReq.send/notify is not available inside tasksPlugin own handlers'
                        )
                    );
                const sid = env?.sessionId;
                const ctx: BaseContext = {
                    sessionId: sid,
                    ext: nextEnv.ext,
                    mcpReq: {
                        id: request.id,
                        method: request.method,
                        signal: env?.signal ?? new AbortController().signal,
                        send: unsupported,
                        notify: unsupported
                    }
                };
                try {
                    const result = await own((request.params ?? {}) as Record<string, unknown>, ctx);
                    yield { kind: 'response', message: { jsonrpc: '2.0', id: request.id, result } };
                } catch (error) {
                    const e = error as { code?: number; message?: string; data?: unknown };
                    yield {
                        kind: 'response',
                        message: {
                            jsonrpc: '2.0',
                            id: request.id,
                            error: {
                                code: Number.isSafeInteger(e?.code) ? (e.code as number) : ProtocolErrorCode.InternalError,
                                message: e?.message ?? 'Internal error',
                                ...(e?.data !== undefined && { data: e.data })
                            }
                        }
                    };
                }
                return;
            }

            yield* next(request, nextEnv);
        };
}

/**
 * Minimal interface a {@linkcode pollTask} caller must satisfy: a `request()` that
 * speaks `tasks/get` and `tasks/result`. Both `Client` and `McpServer` qualify.
 */
export interface TasksPollHost {
    request<T extends StandardSchemaV1>(req: Request, schema: T, options?: RequestOptions): Promise<StandardSchemaV1.InferOutput<T>>;
}

/**
 * Client-side polling helper. Given a `{resultType: 'task', task}` result, polls
 * `tasks/get` until terminal then fetches `tasks/result`. When `resultSchema` is
 * supplied the result is validated against it; otherwise the raw `Result` is returned.
 * No SDK interception; callers invoke explicitly.
 */
export async function pollTask(
    host: TasksPollHost,
    taskId: string,
    resultSchema?: undefined,
    options?: RequestOptions & { defaultPollInterval?: number }
): Promise<Result>;
export async function pollTask<T extends StandardSchemaV1>(
    host: TasksPollHost,
    taskId: string,
    resultSchema: T,
    options?: RequestOptions & { defaultPollInterval?: number }
): Promise<StandardSchemaV1.InferOutput<T>>;
export async function pollTask<T extends StandardSchemaV1>(
    host: TasksPollHost,
    taskId: string,
    resultSchema?: T,
    options?: RequestOptions & { defaultPollInterval?: number }
): Promise<StandardSchemaV1.InferOutput<T> | Result> {
    const TASK_SCHEMA: StandardSchemaV1<unknown, GetTaskResult> = {
        '~standard': { version: 1, vendor: 'mcp-passthrough', validate: v => ({ value: v as GetTaskResult }) }
    };
    const maxTotal = options?.maxTotalTimeout ?? POLL_TASK_DEFAULT_MAX_TOTAL_MS;
    const deadline = Date.now() + maxTotal;
    // maxTotalTimeout bounds this loop, not each tasks/get; pass through other RequestOptions.
    const { maxTotalTimeout: _drop, defaultPollInterval: _drop2, ...perCallOptions } = options ?? {};
    void _drop;
    void _drop2;
    while (true) {
        options?.signal?.throwIfAborted();
        if (Date.now() >= deadline) {
            throw new ProtocolError(
                ProtocolErrorCode.InternalError,
                `pollTask: task ${taskId} did not reach a terminal state within maxTotalTimeout (${maxTotal}ms)`
            );
        }
        const task = await host.request({ method: 'tasks/get', params: { taskId } }, TASK_SCHEMA, perCallOptions);
        if (isTerminal(task.status)) {
            if (task.status === 'cancelled') {
                throw new ProtocolError(ProtocolErrorCode.InternalError, `Task ${taskId} was cancelled`);
            }
            const raw = await host.request({ method: 'tasks/result', params: { taskId } }, TASK_SCHEMA, perCallOptions);
            if (resultSchema === undefined) return raw as Result;
            const parsed = await validateStandardSchema(resultSchema, raw);
            if (!parsed.success) throw new ProtocolError(ProtocolErrorCode.InternalError, parsed.error);
            return parsed.data;
        }
        const interval = task.pollInterval ?? options?.defaultPollInterval ?? 1000;
        await sleep(interval, options?.signal);
    }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const onAbort = () => {
            clearTimeout(t);
            reject(signal!.reason);
        };
        const t = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** Default upper bound on {@linkcode pollTask}'s total wall-clock time when `maxTotalTimeout` is unset. */
export const POLL_TASK_DEFAULT_MAX_TOTAL_MS = 600_000;
