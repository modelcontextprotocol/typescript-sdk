/**
 * Experimental {@linkcode McpServer} task features for MCP SDK.
 * WARNING: These APIs are experimental and may change without notice.
 *
 * @experimental
 */

import type { AnySchema, TaskToolExecution, ToolAnnotations, ToolExecution } from '@modelcontextprotocol/core';

import type { AnyToolHandler, McpServer, RegisteredTool } from '../../server/mcp.js';
import type { ToolTaskHandler } from './interfaces.js';

/**
 * Internal interface for accessing {@linkcode McpServer}'s private _createRegisteredTool method.
 * @internal
 */
interface McpServerInternal {
    _createRegisteredTool(
        name: string,
        title: string | undefined,
        description: string | undefined,
        inputSchema: AnySchema | undefined,
        outputSchema: AnySchema | undefined,
        annotations: ToolAnnotations | undefined,
        execution: ToolExecution | undefined,
        _meta: Record<string, unknown> | undefined,
        handler: AnyToolHandler<AnySchema | undefined>
    ): RegisteredTool;
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
    constructor(private readonly _mcpServer: McpServer) {}

    /**
     * Registers a task-based tool with a config object and handler.
     *
     * Task-based tools support long-running operations that can be polled for status
     * and results. The handler must implement {@linkcode ToolTaskHandler.createTask | createTask}, {@linkcode ToolTaskHandler.getTask | getTask}, and {@linkcode ToolTaskHandler.getTaskResult | getTaskResult}
     * methods.
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
     *   },
     *   getTask: async (args, ctx) => {
     *     return ctx.task.store.getTask(ctx.task.id);
     *   },
     *   getTaskResult: async (args, ctx) => {
     *     return ctx.task.store.getTaskResult(ctx.task.id);
     *   }
     * });
     * ```
     *
     * @param name - The tool name
     * @param config - Tool configuration (description, schemas, etc.)
     * @param handler - Task handler with {@linkcode ToolTaskHandler.createTask | createTask}, {@linkcode ToolTaskHandler.getTask | getTask}, {@linkcode ToolTaskHandler.getTaskResult | getTaskResult} methods
     * @returns {@linkcode server/mcp.RegisteredTool | RegisteredTool} for managing the tool's lifecycle
     *
     * @experimental
     */
    registerToolTask<OutputArgs extends AnySchema | undefined>(
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

    registerToolTask<InputArgs extends AnySchema, OutputArgs extends AnySchema | undefined>(
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

    registerToolTask<InputArgs extends AnySchema | undefined, OutputArgs extends AnySchema | undefined>(
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
            handler as AnyToolHandler<AnySchema | undefined>
        );
    }
}
