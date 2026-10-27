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
 *     const handle = store.handle(task.taskId);
 *     void runReport(handle, input).catch(error => handle.fail({ code: -32_603, message: String(error) }));
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
import type { CancelTaskResult, CreateTaskResult, GetTaskResult, UpdateTaskResult } from '@modelcontextprotocol/core-internal/ext/tasks';
import {
    cancelTaskParamsSchema,
    getTaskParamsSchema,
    inputResponsesSchema,
    TASKS_EXTENSION_ID
} from '@modelcontextprotocol/core-internal/ext/tasks';

import type { ServerExtension, ServerExtensionContext } from '../../server/extension';
import type { CreateTaskParams, TaskStore } from './store';

/** Options for {@link TasksExtension}. */
export interface TasksExtensionOptions {
    /** Default retention for `create` when the caller gives none, ms; `null` = unlimited. Default 86_400_000 (24h). */
    defaultTtlMs?: number | null;
    /** Default polling hint for `create` when the caller gives none, ms. Default 5_000. */
    defaultPollIntervalMs?: number;
    /**
     * The identity a task is bound to, read from the request that creates it
     * and checked on every `tasks/*` request: a request with a different
     * principal gets "Task not found". `undefined` leaves the task unbound, so
     * its id is the only credential. The default is the OAuth client id plus
     * the token subject at `authInfo.extra.sub` when the token verifier sets
     * one; with a client shared between users and no subject there, set this
     * to the user's identity, or every user of that client can reach the
     * others' tasks.
     */
    principal?: (ctx: ServerContext) => string | undefined;
}

/** What a tool handler passes to {@link TasksExtension.create}; every field optional. */
export type CreateTaskOptions = Partial<Omit<CreateTaskParams, 'principal'>>;

/**
 * The task handle a tool handler returns in place of a `CallToolResult`.
 * The 2026-07-28 result encoder forwards `resultType: "task"` for `tools/call`
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
    if (ctx.mcpReq.envelope === undefined) {
        // Every 2026-07-28 request carries the envelope, so this is a 2025-11-25 request.
        throw new MissingRequiredClientCapabilityError(
            { requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } },
            `${what} requires a 2026-07-28 request that declares the "${TASKS_EXTENSION_ID}" extension; it is not served on 2025-11-25`
        );
    }
    throw new MissingRequiredClientCapabilityError(
        { requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } },
        `${what} requires the request to declare the "${TASKS_EXTENSION_ID}" extension capability`
    );
};

/** The default principal: the OAuth client id, with the token subject when the verifier exposes one. */
const defaultTaskPrincipal = (ctx: ServerContext): string | undefined => {
    const authInfo = ctx.http?.authInfo;
    if (authInfo === undefined) return undefined;
    const subject = authInfo.extra?.['sub'];
    return typeof subject === 'string' ? JSON.stringify([authInfo.clientId, subject]) : authInfo.clientId;
};

// The extension's methods are not served on 2025-11-25, where tasks/get and tasks/cancel are other, core methods.
const requireModernRequest = (ctx: ServerContext): void => {
    if (ctx.mcpReq.envelope === undefined) throw new ProtocolError(ProtocolErrorCode.MethodNotFound, 'Method not found');
};

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
    readonly store: TaskStore;
    readonly #defaultTtlMs: number | null;
    readonly #defaultPollIntervalMs: number;
    readonly #principal: (ctx: ServerContext) => string | undefined;

    constructor(store: TaskStore, options?: TasksExtensionOptions) {
        this.store = store;
        this.#principal = options?.principal ?? defaultTaskPrincipal;
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
        const principal = this.#principal(ctx);
        const task = await this.store.create({
            ttlMs: options?.ttlMs === undefined ? this.#defaultTtlMs : options.ttlMs,
            pollIntervalMs: options?.pollIntervalMs ?? this.#defaultPollIntervalMs,
            ...(principal !== undefined && { principal }),
            ...(options?.context !== undefined && { context: options.context })
        });
        const result: CreateTaskResult = { resultType: 'task', ...task };
        return result as TaskToolResult;
    }

    /**
     * Registers the extension's methods and its `tools/call` middleware. The
     * server calls this for each entry in `extensions`.
     *
     * Experimental: the extension shape may change in a minor release.
     *
     * @experimental
     */
    setup(ctx: ServerExtensionContext): void {
        ctx.setRequestHandler('tasks/get', { params: getTaskParamsSchema }, async (params, requestCtx): Promise<GetTaskResult> => {
            requireModernRequest(requestCtx);
            requireTasksExtension(requestCtx, 'tasks/get');
            const task = await this.store.get(params.taskId, { principal: this.#principal(requestCtx) });
            if (task === undefined) return notFound();
            return { resultType: 'complete', ...task };
        });

        ctx.setRequestHandler(
            'tasks/update',
            { params: updateTaskHandlerParamsSchema },
            async (params, requestCtx): Promise<UpdateTaskResult> => {
                requireModernRequest(requestCtx);
                requireTasksExtension(requestCtx, 'tasks/update');
                const dropped = requestCtx.mcpReq.droppedInputResponseKeys ?? [];
                if (dropped.length > 0) {
                    throw new ProtocolError(
                        ProtocolErrorCode.InvalidParams,
                        `inputResponses entries must be bare results; refused: ${dropped.join(', ')}`
                    );
                }
                const inputResponses = (requestCtx.mcpReq.inputResponses ?? params.inputResponses) as InputResponses | undefined;
                if (inputResponses === undefined)
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'tasks/update requires inputResponses');
                const found = await this.store.update(params.taskId, inputResponses, { principal: this.#principal(requestCtx) });
                if (!found) return notFound();
                return { resultType: 'complete' };
            }
        );

        ctx.setRequestHandler('tasks/cancel', { params: cancelTaskParamsSchema }, async (params, requestCtx): Promise<CancelTaskResult> => {
            requireModernRequest(requestCtx);
            requireTasksExtension(requestCtx, 'tasks/cancel');
            const found = await this.store.cancel(params.taskId, { principal: this.#principal(requestCtx) });
            if (!found) return notFound();
            return { resultType: 'complete' };
        });

        // Refuses task handles minted outside `create` to a client that cannot consume them, cancelling the task first.
        ctx.use('tools/call', async (request: JSONRPCRequest, requestCtx, next): Promise<Result> => {
            const result = await next(request, requestCtx);
            const handle = result as { resultType?: unknown; taskId?: unknown };
            if (handle.resultType !== 'task') return result;
            try {
                requireTasksExtension(requestCtx, `Tool "${String((request.params as { name?: unknown })?.name)}" executes as a task and`);
            } catch (error) {
                if (typeof handle.taskId === 'string') {
                    await this.store.cancel(handle.taskId, { principal: this.#principal(requestCtx) }).catch(() => false);
                }
                throw error;
            }
            return result;
        });
    }
}
