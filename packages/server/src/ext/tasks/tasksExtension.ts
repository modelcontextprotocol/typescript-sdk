/**
 * `TasksExtension` — the server side of the MCP Tasks extension
 * (`io.modelcontextprotocol/tasks`) as a {@linkcode ServerExtension}. It
 * owns the wire: the capability, the per-request client-capability check,
 * the `tasks/get`, `tasks/update` and `tasks/cancel` methods, and the
 * `tools/call` result shape. Everything about the task itself — where its
 * state lives, how its work runs — is behind the {@link TaskStore} the
 * server passes in.
 *
 * ```ts
 * const store = new InMemoryTaskStore();
 * const tasks = new TasksExtension(store);
 * const server = new McpServer(info, { extensions: [tasks] });
 *
 * server.registerTool('send_report', { inputSchema }, async (input, ctx) => {
 *     const task = await tasks.create(ctx, { ttlMs: 3_600_000 });
 *     void runReport(store.handle(task.taskId), input); // the server's own execution
 *     return task;
 * });
 * ```
 */

import type { CallToolResult, InputResponses, JSONRPCRequest, Result, ServerContext } from '@modelcontextprotocol/core-internal';
import {
    CLIENT_CAPABILITIES_META_KEY,
    MissingRequiredClientCapabilityError,
    ProtocolError,
    ProtocolErrorCode
} from '@modelcontextprotocol/core-internal';

import type { ServerExtension } from '../../server/extension';
import type { Server } from '../../server/server';
import type { CreateTaskParams, TaskStore } from './store';
import { cancelTaskParamsSchema, getTaskParamsSchema, inputResponsesSchema } from './wire/schemas';
import type { CancelTaskResult, CreateTaskResult, GetTaskResult, UpdateTaskResult } from './wire/types';
import { TASKS_EXTENSION_ID } from './wire/types';

/** Options for {@link TasksExtension}. */
export interface TasksExtensionOptions {
    /** Default retention for `create` when the caller gives none, ms; `null` = unlimited. Default 86_400_000 (24h). */
    defaultTtlMs?: number | null;
    /** Default polling hint for `create` when the caller gives none, ms. Default 5_000. */
    defaultPollIntervalMs?: number;
}

/** What a tool handler passes to {@link TasksExtension.create}; every field optional. */
export type CreateTaskOptions = Partial<Omit<CreateTaskParams, 'principal'>>;

/**
 * The task handle a tool handler returns in place of a `CallToolResult`.
 * The 2026-07-28 encode seam forwards `resultType: "task"` for `tools/call`
 * verbatim, so the flat handle is the wire result.
 */
export type TaskToolResult = CallToolResult & CreateTaskResult;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Whether this request's `_meta` envelope declared the tasks extension. */
export const declaresTasksExtension = (ctx: ServerContext): boolean => {
    const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
    const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY];
    if (!isRecord(capabilities)) return false;
    const extensions = capabilities['extensions'];
    return isRecord(extensions) && TASKS_EXTENSION_ID in extensions;
};

const requireTasksExtension = (ctx: ServerContext, what: string): void => {
    if (declaresTasksExtension(ctx)) return;
    throw new MissingRequiredClientCapabilityError(
        { requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } },
        `${what} requires the request to declare the "${TASKS_EXTENSION_ID}" extension capability`
    );
};

const principalOf = (ctx: ServerContext): string | undefined => ctx.http?.authInfo?.clientId;

const notFound = (): never => {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task not found');
};

/**
 * `tasks/update` params as the HANDLER sees them. `inputResponses` is a
 * reserved multi-round-trip name on the 2026-07-28 revision: the protocol
 * layer lifts it out of every client request's params before dispatch and
 * surfaces it at `ctx.mcpReq.inputResponses`. The wire schema
 * (`updateTaskParamsSchema`) keeps the field required; here it is optional
 * and read back from the context.
 */
const updateTaskHandlerParamsSchema = getTaskParamsSchema.extend({ inputResponses: inputResponsesSchema.optional() });

export class TasksExtension implements ServerExtension {
    readonly id = TASKS_EXTENSION_ID;
    readonly capability = {};
    readonly store: TaskStore;
    readonly #defaultTtlMs: number | null;
    readonly #defaultPollIntervalMs: number;

    constructor(store: TaskStore, options?: TasksExtensionOptions) {
        this.store = store;
        this.#defaultTtlMs = options?.defaultTtlMs === undefined ? 86_400_000 : options.defaultTtlMs;
        this.#defaultPollIntervalMs = options?.defaultPollIntervalMs ?? 5000;
    }

    /**
     * Creates a task for the current `tools/call` and returns the handle the
     * tool handler answers with. Refuses (`-32021`) when the request did not
     * declare the extension; binds the task to the request's principal when
     * the transport knows one.
     */
    async create(ctx: ServerContext, options?: CreateTaskOptions): Promise<TaskToolResult> {
        requireTasksExtension(ctx, `Tool "${ctx.mcpReq.method}" executes as a task and`);
        const principal = principalOf(ctx);
        const task = await this.store.create({
            ttlMs: options?.ttlMs === undefined ? this.#defaultTtlMs : options.ttlMs,
            pollIntervalMs: options?.pollIntervalMs ?? this.#defaultPollIntervalMs,
            ...(principal !== undefined && { principal }),
            ...(options?.context !== undefined && { context: options.context })
        });
        const result: CreateTaskResult = { resultType: 'task', ...task };
        return result as TaskToolResult;
    }

    install(server: Server): void {
        server.setRequestHandler('tasks/get', { params: getTaskParamsSchema }, async (params, ctx): Promise<GetTaskResult> => {
            requireTasksExtension(ctx, 'tasks/get');
            const task = await this.store.get(params.taskId, { principal: principalOf(ctx) });
            if (task === undefined) return notFound();
            return { resultType: 'complete', ...task };
        });

        server.setRequestHandler(
            'tasks/update',
            { params: updateTaskHandlerParamsSchema },
            async (params, ctx): Promise<UpdateTaskResult> => {
                requireTasksExtension(ctx, 'tasks/update');
                const inputResponses = (ctx.mcpReq.inputResponses ?? params.inputResponses ?? {}) as InputResponses;
                const found = await this.store.update(params.taskId, inputResponses, { principal: principalOf(ctx) });
                if (!found) return notFound();
                return { resultType: 'complete' };
            }
        );

        server.setRequestHandler('tasks/cancel', { params: cancelTaskParamsSchema }, async (params, ctx): Promise<CancelTaskResult> => {
            requireTasksExtension(ctx, 'tasks/cancel');
            const found = await this.store.cancel(params.taskId, { principal: principalOf(ctx) });
            if (!found) return notFound();
            return { resultType: 'complete' };
        });

        // A task handle may only be answered to a client that can consume it.
        // `create(ctx, …)` checks up front; this catches handles minted some
        // other way (an external engine's own create) — the extension owns
        // the wire regardless of where the task came from.
        server.overrideRequestHandler('tools/call', async (request: JSONRPCRequest, ctx, next): Promise<Result> => {
            const result = await next(request, ctx);
            if ((result as { resultType?: unknown }).resultType === 'task') {
                requireTasksExtension(ctx, `Tool "${String((request.params as { name?: unknown })?.name)}" executes as a task and`);
            }
            return result;
        });
    }
}
