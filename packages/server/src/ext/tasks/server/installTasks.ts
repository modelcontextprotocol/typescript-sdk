/**
 * `installTasks` — wires the Tasks extension (`io.modelcontextprotocol/tasks`)
 * onto an `McpServer` for a chosen {@link TaskEngine}, and returns the
 * `registerTask` surface. It is `registerTool` for long-running work: the
 * handler runs as a replayable workflow against the engine, and the
 * extension's `tasks/get`, `tasks/update` and `tasks/cancel` methods are
 * served as explicit-schema custom methods that route to the engine.
 *
 * The tool's `tools/call` handler answers a flat `CreateTaskResult`
 * (`resultType: "task"`), which the 2026-07-28 encode seam passes through
 * verbatim for `tools/call`. A client that did not declare the extension on
 * the request is refused with `MissingRequiredClientCapability` (`-32021`).
 */

import type { CallToolResult, InputResponses, McpServer, ServerContext, StandardSchemaWithJSON, ToolAnnotations } from '../../../index';
import { CLIENT_CAPABILITIES_META_KEY, MissingRequiredClientCapabilityError, ProtocolError, ProtocolErrorCode } from '../../../index';
import { DEFAULT_POLL_INTERVAL_MS, DEFAULT_RETRY_POLICY, DEFAULT_TTL_MS } from '../engine/defaults';
import { createTaskExecutor } from '../engine/executor';
import type { TaskEngine } from '../engine/taskEngine';
import { cancelTaskParamsSchema, getTaskParamsSchema, inputResponsesSchema } from '../wire/schemas';
import type { CancelTaskResult, CreateTaskResult, GetTaskResult, UpdateTaskResult } from '../wire/types';
import { TASKS_EXTENSION_ID } from '../wire/types';
import type { AnyTaskHandler, RegisteredTask, TaskConfig, TaskHandler, TaskRegistration } from './registration';

/** Options for {@link installTasks}. */
export interface InstallTasksOptions {
    /** The execution engine every task registered on this server runs on. */
    engine: TaskEngine;
}

/** The task registration surface returned by {@link installTasks}. */
export interface Tasks {
    readonly engine: TaskEngine;
    /**
     * Registers a task. It is advertised as a normal tool (no `outputSchema`);
     * a `tools/call` from a client that declared the tasks extension returns a
     * `CreateTaskResult` immediately while the handler runs on the engine.
     */
    registerTask<In extends StandardSchemaWithJSON | undefined = undefined>(
        name: string,
        config: TaskConfig<In>,
        handler: TaskHandler<In>
    ): RegisteredTask;
    /** Resolved registration for an executor. */
    getTaskRegistration(name: string): TaskRegistration | undefined;
    /** The registered task names. */
    readonly taskNames: string[];
}

/** Whether this request's `_meta` envelope declared the tasks extension. */
const declaredTasksExtension = (ctx: ServerContext): boolean => {
    const envelope = ctx.mcpReq?.envelope as Record<string, unknown> | undefined;
    const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY];
    if (capabilities === null || typeof capabilities !== 'object') return false;
    const extensions = (capabilities as Record<string, unknown>)['extensions'];
    return extensions !== null && typeof extensions === 'object' && TASKS_EXTENSION_ID in extensions;
};

const requireTasksExtension = (ctx: ServerContext, what: string): void => {
    if (declaredTasksExtension(ctx)) return;
    throw new MissingRequiredClientCapabilityError(
        { requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } },
        `${what} requires the request to declare the "${TASKS_EXTENSION_ID}" extension capability`
    );
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

const principalOf = (ctx: ServerContext): string | undefined => ctx.http?.authInfo?.clientId;

const notFound = (): never => {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task not found');
};

/**
 * Installs the Tasks extension on `server` against `engine` and returns the
 * `registerTask` surface. Call once per server instance; the extension
 * capability is advertised once the first task is registered.
 */
export function installTasks(server: McpServer, options: InstallTasksOptions): Tasks {
    const { engine } = options;
    const registrations = new Map<string, TaskRegistration>();
    const registry = { getTaskRegistration: (name: string) => registrations.get(name) };
    engine.attach?.(createTaskExecutor(registry));

    server.server.setRequestHandler('tasks/get', { params: getTaskParamsSchema }, async (params, ctx): Promise<GetTaskResult> => {
        requireTasksExtension(ctx, 'tasks/get');
        const task = await engine.get(params.taskId, { principal: principalOf(ctx) });
        if (task === undefined) return notFound();
        return { resultType: 'complete', ...task };
    });

    server.server.setRequestHandler(
        'tasks/update',
        { params: updateTaskHandlerParamsSchema },
        async (params, ctx): Promise<UpdateTaskResult> => {
            requireTasksExtension(ctx, 'tasks/update');
            const inputResponses = (ctx.mcpReq.inputResponses ?? params.inputResponses ?? {}) as InputResponses;
            const found = await engine.update(params.taskId, inputResponses, { principal: principalOf(ctx) });
            if (!found) return notFound();
            return { resultType: 'complete' };
        }
    );

    server.server.setRequestHandler('tasks/cancel', { params: cancelTaskParamsSchema }, async (params, ctx): Promise<CancelTaskResult> => {
        requireTasksExtension(ctx, 'tasks/cancel');
        const found = await engine.cancel(params.taskId, { principal: principalOf(ctx) });
        if (!found) return notFound();
        return { resultType: 'complete' };
    });

    const createTask = async (registration: TaskRegistration, input: unknown, ctx: ServerContext): Promise<CallToolResult> => {
        requireTasksExtension(ctx, `Tool "${registration.name}" executes as a task and`);
        const principal = principalOf(ctx);
        const task = await engine.create({
            taskName: registration.name,
            input,
            ttlMs: registration.ttlMs,
            pollIntervalMs: registration.pollIntervalMs,
            ...(principal !== undefined && { principal })
        });
        const result: CreateTaskResult = { resultType: 'task', ...task };
        // The 2026-07-28 encode seam forwards a handler-provided `resultType`
        // for `tools/call` verbatim; the flat task handle is the wire result.
        return result as unknown as CallToolResult;
    };

    return {
        engine,
        registerTask(name, config, handler) {
            if ('outputSchema' in config && config.outputSchema !== undefined) {
                throw new TypeError(`registerTask("${name}"): outputSchema is not supported — the tool answers a task handle`);
            }
            if (registrations.has(name)) {
                throw new Error(`Task "${name}" is already registered`);
            }
            const registration: TaskRegistration = {
                name,
                ttlMs: config.ttlMs === undefined ? DEFAULT_TTL_MS : config.ttlMs,
                pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
                retries: {
                    limit: config.retries?.limit ?? DEFAULT_RETRY_POLICY.limit,
                    baseDelayMs: config.retries?.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs,
                    maxDelayMs: config.retries?.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs
                },
                inputSchema: config.inputSchema,
                handler: handler as AnyTaskHandler
            };
            const sdkConfig: {
                title?: string;
                description?: string;
                inputSchema?: StandardSchemaWithJSON;
                annotations?: ToolAnnotations;
            } = {
                title: config.title,
                description: config.description,
                inputSchema: config.inputSchema,
                annotations: config.annotations
            };
            // The SDK invokes the callback as (args, ctx) when an inputSchema is
            // registered and as (ctx) otherwise; one wire handler covers both.
            const hasInput = config.inputSchema !== undefined;
            const wireHandler = (first: unknown, second?: unknown): Promise<CallToolResult> => {
                const ctx = (hasInput ? second : first) as ServerContext;
                return createTask(registration, hasInput ? first : undefined, ctx);
            };
            const tool = server.registerTool(name, sdkConfig, wireHandler);
            registrations.set(name, registration);
            if (registrations.size === 1) {
                server.server.registerCapabilities({ extensions: { [TASKS_EXTENSION_ID]: {} } });
            }
            return {
                enable: () => tool.enable(),
                disable: () => tool.disable(),
                remove: () => {
                    registrations.delete(name);
                    tool.remove();
                }
            };
        },
        getTaskRegistration: registry.getTaskRegistration,
        get taskNames() {
            return [...registrations.keys()];
        }
    };
}
