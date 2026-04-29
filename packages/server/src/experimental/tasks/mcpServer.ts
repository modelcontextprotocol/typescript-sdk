/**
 * Experimental {@linkcode McpServer} task features for MCP SDK.
 * WARNING: These APIs are experimental and may change without notice.
 *
 * @experimental
 */

import type {
    BaseContext,
    CallToolResult,
    GetTaskResult,
    ServerContext,
    StandardSchemaWithJSON,
    TaskManager,
    TaskServerContext,
    TaskToolExecution,
    ToolAnnotations,
    ToolExecution
} from '@modelcontextprotocol/core';

import type { AnyToolHandler, McpServer, RegisteredTool } from '../../server/mcp.js';
import type { ToolTaskHandler } from './interfaces.js';
import { isToolTaskHandler } from './interfaces.js';

/**
 * Internal interface for accessing {@linkcode McpServer}'s private members.
 * @internal
 */
interface McpServerInternal {
    _createRegisteredTool(
        name: string,
        title: string | undefined,
        description: string | undefined,
        inputSchema: StandardSchemaWithJSON | undefined,
        outputSchema: StandardSchemaWithJSON | undefined,
        annotations: ToolAnnotations | undefined,
        execution: ToolExecution | undefined,
        _meta: Record<string, unknown> | undefined,
        handler: AnyToolHandler<StandardSchemaWithJSON | undefined>
    ): RegisteredTool;
    _registeredTools: { [name: string]: RegisteredTool };
}

/**
 * Experimental task features for {@linkcode McpServer}.
 *
 * Access via `server.experimental.tasks`:
 * ```typescript
 * server.experimental.tasks.registerToolTask('long-running', config, handler);
 * ```
 *
 * @experimental
 */
export class ExperimentalMcpServerTasks {
    /**
     * Maps taskId → toolName for tasks whose handlers define custom
     * `getTask` or `getTaskResult`. In-memory only; after a server restart
     * or on a different instance, lookups fall through to the TaskStore.
     */
    private _taskToTool = new Map<string, string>();

    constructor(private readonly _mcpServer: McpServer) {}

    /** @internal */
    _installOverrides(taskManager: TaskManager): void {
        taskManager.setTaskOverrides({
            getTask: (taskId, ctx) => this._dispatch(taskId, ctx, 'getTask'),
            getTaskResult: (taskId, ctx) => this._dispatch(taskId, ctx, 'getTaskResult')
        });
    }

    /** @internal */
    _recordTask(taskId: string, toolName: string): void {
        const tool = (this._mcpServer as unknown as McpServerInternal)._registeredTools[toolName];
        if (tool && isToolTaskHandler(tool.handler) && (tool.handler.getTask || tool.handler.getTaskResult)) {
            this._taskToTool.set(taskId, toolName);
        }
    }

    /** @internal */
    onClose(): void {
        this._taskToTool.clear();
    }

    private async _dispatch<M extends 'getTask' | 'getTaskResult'>(
        taskId: string,
        ctx: BaseContext,
        method: M
    ): Promise<(M extends 'getTask' ? GetTaskResult : CallToolResult) | undefined> {
        const toolName = this._taskToTool.get(taskId);
        if (!toolName) return undefined;

        const tool = (this._mcpServer as unknown as McpServerInternal)._registeredTools[toolName];
        if (!tool || !isToolTaskHandler(tool.handler)) return undefined;

        const handler = tool.handler[method];
        if (!handler) return undefined;

        const serverCtx = ctx as ServerContext;
        if (!serverCtx.task?.store) return undefined;

        const taskCtx: TaskServerContext = {
            ...serverCtx,
            task: { ...serverCtx.task, id: taskId, store: serverCtx.task.store }
        };

        const result = (await handler(taskCtx)) as M extends 'getTask' ? GetTaskResult : CallToolResult;
        // getTaskResult is terminal — drop the mapping only after the handler resolves
        // so a transient throw doesn't orphan the task on retry.
        if (method === 'getTaskResult') {
            this._taskToTool.delete(taskId);
        }
        return result;
    }

    /**
     * Registers a task-based tool with a config object and handler.
     *
     * Task-based tools support long-running operations that can be polled for status
     * and results. The handler implements {@linkcode ToolTaskHandler.createTask | createTask}
     * to start the task; subsequent `tasks/get` and `tasks/result` requests are served
     * from the configured `TaskStore`.
     *
     * @example
     * ```typescript
     * server.experimental.tasks.registerToolTask('long-computation', {
     *   description: 'Performs a long computation',
     *   inputSchema: z.object({ input: z.string() }),
     *   execution: { taskSupport: 'required' }
     * }, {
     *   createTask: async (args, ctx) => {
     *     const task = await ctx.task.store.createTask({ ttl: 300000 });
     *     startBackgroundWork(task.taskId, args);
     *     return { task };
     *   }
     * });
     * ```
     *
     * @param name - The tool name
     * @param config - Tool configuration (description, schemas, etc.)
     * @param handler - Task handler with {@linkcode ToolTaskHandler.createTask | createTask}
     * @returns {@linkcode server/mcp.RegisteredTool | RegisteredTool} for managing the tool's lifecycle
     *
     * @experimental
     */
    registerToolTask<OutputArgs extends StandardSchemaWithJSON | undefined>(
        name: string,
        config: {
            title?: string;
            description?: string;
            outputSchema?: OutputArgs;
            annotations?: ToolAnnotations;
            execution?: TaskToolExecution;
            _meta?: Record<string, unknown>;
        },
        handler: ToolTaskHandler<undefined>
    ): RegisteredTool;

    registerToolTask<InputArgs extends StandardSchemaWithJSON, OutputArgs extends StandardSchemaWithJSON | undefined>(
        name: string,
        config: {
            title?: string;
            description?: string;
            inputSchema: InputArgs;
            outputSchema?: OutputArgs;
            annotations?: ToolAnnotations;
            execution?: TaskToolExecution;
            _meta?: Record<string, unknown>;
        },
        handler: ToolTaskHandler<InputArgs>
    ): RegisteredTool;

    registerToolTask<InputArgs extends StandardSchemaWithJSON | undefined, OutputArgs extends StandardSchemaWithJSON | undefined>(
        name: string,
        config: {
            title?: string;
            description?: string;
            inputSchema?: InputArgs;
            outputSchema?: OutputArgs;
            annotations?: ToolAnnotations;
            execution?: TaskToolExecution;
            _meta?: Record<string, unknown>;
        },
        handler: ToolTaskHandler<InputArgs>
    ): RegisteredTool {
        // Validate that taskSupport is not 'forbidden' for task-based tools
        const execution: ToolExecution = { taskSupport: 'required', ...config.execution };
        if (execution.taskSupport === 'forbidden') {
            throw new Error(`Cannot register task-based tool '${name}' with taskSupport 'forbidden'. Use registerTool() instead.`);
        }

        // Access McpServer's internal _createRegisteredTool method
        const mcpServerInternal = this._mcpServer as unknown as McpServerInternal;
        return mcpServerInternal._createRegisteredTool(
            name,
            config.title,
            config.description,
            config.inputSchema,
            config.outputSchema,
            config.annotations,
            execution,
            config._meta,
            handler as AnyToolHandler<StandardSchemaWithJSON | undefined>
        );
    }
}
