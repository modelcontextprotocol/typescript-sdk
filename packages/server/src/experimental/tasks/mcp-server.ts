/**
 * Experimental McpServer task features for MCP SDK.
 * WARNING: These APIs are experimental and may change without notice.
 *
 * @experimental
 */

import type { AnySchema, TaskToolExecution, ToolAnnotations, ToolExecution, ZodRawShapeCompat } from '@modelcontextprotocol/core';

import type { AnyToolHandler, McpServer, RegisteredTool } from '../../server/mcp.js';
import type { ToolTaskHandler } from './interfaces.js';

/**
 * Internal interface for accessing McpServer's private _createRegisteredTool method.
 * @internal
 */
interface McpServerInternal {
    _createRegisteredTool(
        name: string,
        title: string | undefined,
        description: string | undefined,
        inputSchema: ZodRawShapeCompat | AnySchema | undefined,
        outputSchema: ZodRawShapeCompat | AnySchema | undefined,
        annotations: ToolAnnotations | undefined,
        execution: ToolExecution | undefined,
        _meta: Record<string, unknown> | undefined,
        handler: AnyToolHandler<ZodRawShapeCompat | undefined>
    ): RegisteredTool;
}

/**
 * Experimental task features for McpServer.
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
     * and results. The handler must implement `createTask`, `getTask`, and `getTaskResult`
     * methods.
     *
     * @example
     * ```typescript
     * server.experimental.tasks.registerToolTask('long-computation', {
     *   description: 'Performs a long computation',
     *   inputSchema: { input: z.string() },
     *   execution: { taskSupport: 'required' }
     * }, {
     *   createTask: async (args, extra) => {
     *     const task = await extra.taskStore.createTask({ ttl: 300000 });
     *     startBackgroundWork(task.taskId, args);
     *     return { task };
     *   },
     *   getTask: async (args, extra) => {
     *     return extra.taskStore.getTask(extra.taskId);
     *   },
     *   getTaskResult: async (args, extra) => {
     *     return extra.taskStore.getTaskResult(extra.taskId);
     *   }
     * });
     * ```
     *
     * @param name - The tool name
     * @param config - Tool configuration (description, schemas, etc.)
     * @param handler - Task handler with createTask, getTask, getTaskResult methods
     * @returns RegisteredTool for managing the tool's lifecycle
     *
     * @experimental
     */
    registerToolTask<OutputArgs extends undefined | ZodRawShapeCompat | AnySchema>(
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

    registerToolTask<InputArgs extends ZodRawShapeCompat | AnySchema, OutputArgs extends undefined | ZodRawShapeCompat | AnySchema>(
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

    registerToolTask<
        InputArgs extends undefined | ZodRawShapeCompat | AnySchema,
        OutputArgs extends undefined | ZodRawShapeCompat | AnySchema
    >(
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
            handler as AnyToolHandler<ZodRawShapeCompat | undefined>
        );
    }
}
