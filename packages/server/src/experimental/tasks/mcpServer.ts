/**
 * Experimental {@linkcode McpServer} task features for MCP SDK.
 * WARNING: These APIs are experimental and may change without notice.
 *
 * @experimental
 */

import type { ContentBlock, StandardSchemaWithJSON, TaskToolExecution, ToolAnnotations, ToolExecution } from '@modelcontextprotocol/core';
import { isTerminal, TaskPartialNotificationParamsSchema } from '@modelcontextprotocol/core';

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
        inputSchema: StandardSchemaWithJSON | undefined,
        outputSchema: StandardSchemaWithJSON | undefined,
        annotations: ToolAnnotations | undefined,
        execution: ToolExecution | undefined,
        _meta: Record<string, unknown> | undefined,
        handler: AnyToolHandler<StandardSchemaWithJSON | undefined>
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
     * Sends a partial result notification for a task.
     *
     * Validates that the server has declared `tasks.streaming.partial` capability,
     * that the content is non-empty, that seq is a non-negative integer, and that
     * the task is not in a terminal status. If the client has not declared
     * `tasks.streaming.partial` capability, the notification is silently skipped.
     *
     * @param taskId - The task identifier
     * @param content - Non-empty array of ContentBlock items
     * @param seq - Non-negative integer sequence number
     * @throws If content is empty, seq is invalid, task is terminal, or capability not declared
     *
     * @experimental
     */
    async sendTaskPartial(taskId: string, content: ContentBlock[], seq: number): Promise<void> {
        // 1. Check server has declared tasks.streaming.partial capability
        const serverCapabilities = this._mcpServer.server.getCapabilities();
        if (!serverCapabilities.tasks?.streaming?.partial) {
            throw new Error(
                'Server has not declared tasks.streaming.partial capability. ' +
                    'Register a tool with streamPartial: true or explicitly configure streaming capability.'
            );
        }

        // 2. Validate params via Zod schema for consistent error messages
        const parseResult = TaskPartialNotificationParamsSchema.safeParse({ taskId, content, seq });
        if (!parseResult.success) {
            throw new Error(`Invalid TaskPartialNotificationParams: ${parseResult.error.message}`);
        }

        // 3. Look up task status via TaskManager's public taskStore accessor; throw if task is in terminal status
        const taskStore = this._mcpServer.server.taskManager.taskStore;
        if (taskStore) {
            const task = await taskStore.getTask(taskId);
            if (task && isTerminal(task.status)) {
                throw new Error(`Cannot send partial notification for task "${taskId}" in terminal status "${task.status}"`);
            }
        }

        // 4. Check client capabilities for tasks.streaming.partial; skip silently if client lacks support
        const clientCapabilities = this._mcpServer.server.getClientCapabilities();
        if (!clientCapabilities?.tasks?.streaming?.partial) {
            return;
        }

        // 5. Send notification via Server.notification()
        await this._mcpServer.server.notification({
            method: 'notifications/tasks/partial',
            params: parseResult.data
        });
    }

    /**
     * Creates a partial emitter function for a task with automatic seq management.
     *
     * Returns an async function that accepts content and sends a partial notification
     * with auto-incrementing seq (starting at 0). Suitable for use in background work
     * after `createTask` returns.
     *
     * @param taskId - The task identifier
     * @returns An async function that accepts content and sends a partial notification
     *
     * @experimental
     */
    createPartialEmitter(taskId: string): (content: ContentBlock[]) => Promise<void> {
        let seq = 0;
        return async (content: ContentBlock[]) => {
            await this.sendTaskPartial(taskId, content, seq++);
        };
    }

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

        // Automatically declare tasks.streaming.partial capability when streamPartial is true
        if (config.execution?.streamPartial) {
            this._mcpServer.server.registerCapabilities({
                tasks: { streaming: { partial: {} } }
            });
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
