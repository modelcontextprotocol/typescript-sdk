import type {
    AnyObjectSchema,
    AnySchema,
    BaseMetadata,
    CallToolRequest,
    CallToolResult,
    CompleteRequestPrompt,
    CompleteRequestResourceTemplate,
    CompleteResult,
    CreateTaskResult,
    ErrorInterceptionContext,
    ErrorInterceptionResult,
    GetPromptResult,
    Implementation,
    ListPromptsResult,
    ListResourcesResult,
    ListToolsResult,
    LoggingMessageNotification,
    PromptReference,
    ProtocolPlugin,
    Resource,
    ResourceTemplateReference,
    Result,
    SchemaOutput,
    ServerNotification,
    ServerRequest,
    ServerResult,
    ShapeOutput,
    ToolAnnotations,
    ToolExecution,
    Transport,
    ZodRawShapeCompat
} from '@modelcontextprotocol/core';
import {
    assertCompleteRequestPrompt,
    assertCompleteRequestResourceTemplate,
    CallToolRequestSchema,
    CompleteRequestSchema,
    ErrorCode,
    getLiteralValue,
    getObjectShape,
    getParseErrorMessage,
    GetPromptRequestSchema,
    isProtocolError,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    ListToolsRequestSchema,
    normalizeObjectSchema,
    objectFromShape,
    ProtocolError,
    ReadResourceRequestSchema,
    safeParseAsync,
    UriTemplate
} from '@modelcontextprotocol/core';
import { ZodOptional } from 'zod';

import type { ToolTaskHandler } from '../experimental/tasks/interfaces.js';
import { ExperimentalMcpServerTasks } from '../experimental/tasks/mcpServer.js';
import type { PromptArgsRawShape, PromptCallback, ReadResourceCallback, ReadResourceTemplateCallback } from '../types/types.js';
import type {
    BuilderResult,
    ErrorContext,
    OnErrorHandler,
    OnErrorReturn,
    OnProtocolErrorHandler,
    OnProtocolErrorReturn
} from './builder.js';
import { McpServerBuilder } from './builder.js';
import { getCompleter, isCompletable } from './completable.js';
import type { ServerContextInterface } from './context.js';
import type {
    PromptContext,
    PromptMiddleware,
    ResourceContext,
    ResourceMiddleware,
    ToolContext,
    ToolMiddleware,
    UniversalMiddleware
} from './middleware.js';
import { MiddlewareManager } from './middleware.js';
import type { RegisteredPrompt } from './registries/promptRegistry.js';
import { PromptRegistry } from './registries/promptRegistry.js';
import type { RegisteredResourceEntity, RegisteredResourceTemplateEntity } from './registries/resourceRegistry.js';
import { ResourceRegistry, ResourceTemplateRegistry } from './registries/resourceRegistry.js';
import type { RegisteredTool } from './registries/toolRegistry.js';
import { ToolRegistry } from './registries/toolRegistry.js';
import type { ServerOptions } from './server.js';
import { Server } from './server.js';

/**
 * Internal options for McpServer that can include pre-created registries.
 * Used by fromBuilderResult to pass registries from the builder.
 */
interface InternalMcpServerOptions extends ServerOptions {
    /** Pre-created tool registry (callbacks will be bound by McpServer) */
    _toolRegistry?: ToolRegistry;
    /** Pre-created resource registry (callbacks will be bound by McpServer) */
    _resourceRegistry?: ResourceRegistry;
    /** Pre-created prompt registry (callbacks will be bound by McpServer) */
    _promptRegistry?: PromptRegistry;
}

/**
 * High-level MCP server that provides a simpler API for working with resources, tools, and prompts.
 * For advanced usage (like sending notifications or setting custom request handlers), use the underlying
 * Server instance available via the `server` property.
 */
export class McpServer {
    /**
     * The underlying Server instance, useful for advanced operations like sending notifications.
     */
    public readonly server: Server;

    private readonly _toolRegistry: ToolRegistry;
    private readonly _resourceRegistry: ResourceRegistry;
    private readonly _resourceTemplateRegistry: ResourceTemplateRegistry;
    private readonly _promptRegistry: PromptRegistry;
    private readonly _middleware: MiddlewareManager;
    private _experimental?: { tasks: ExperimentalMcpServerTasks };

    // Error handlers (single callback pattern, not event-based)
    private _onErrorHandler?: OnErrorHandler;
    private _onProtocolErrorHandler?: OnProtocolErrorHandler;

    constructor(serverInfo: Implementation, options?: ServerOptions) {
        const internalOptions = options as InternalMcpServerOptions | undefined;
        this.server = new Server(serverInfo, options);

        // Use pre-created registries if provided, otherwise create new ones
        // Either way, bind the notification callbacks to this server instance
        this._toolRegistry = internalOptions?._toolRegistry ?? new ToolRegistry();
        this._toolRegistry.setNotifyCallback(() => this.sendToolListChanged());

        this._resourceRegistry = internalOptions?._resourceRegistry ?? new ResourceRegistry();
        this._resourceRegistry.setNotifyCallback(() => this.sendResourceListChanged());

        // Resource template registry is always created fresh (not passed from builder)
        this._resourceTemplateRegistry = new ResourceTemplateRegistry();
        this._resourceTemplateRegistry.setNotifyCallback(() => this.sendResourceListChanged());

        this._promptRegistry = internalOptions?._promptRegistry ?? new PromptRegistry();
        this._promptRegistry.setNotifyCallback(() => this.sendPromptListChanged());

        // Initialize middleware manager
        this._middleware = new MiddlewareManager();

        // If registries were pre-populated, set up request handlers
        if (this._toolRegistry.size > 0) {
            this.setToolRequestHandlers();
        }
        if (this._resourceRegistry.size > 0) {
            this.setResourceRequestHandlers();
        }
        if (this._promptRegistry.size > 0) {
            this.setPromptRequestHandlers();
        }
    }

    /**
     * Gets the middleware manager for advanced middleware configuration.
     */
    get middleware(): MiddlewareManager {
        return this._middleware;
    }

    /**
     * Registers universal middleware that runs for all request types (tools, resources, prompts).
     *
     * @param middleware - The middleware function to register
     * @returns This McpServer instance for chaining
     */
    useMiddleware(middleware: UniversalMiddleware): this {
        this._middleware.useMiddleware(middleware);
        return this;
    }

    /**
     * Registers middleware specifically for tool calls.
     *
     * @param middleware - The tool middleware function to register
     * @returns This McpServer instance for chaining
     */
    useToolMiddleware(middleware: ToolMiddleware): this {
        this._middleware.useToolMiddleware(middleware);
        return this;
    }

    /**
     * Registers middleware specifically for resource reads.
     *
     * @param middleware - The resource middleware function to register
     * @returns This McpServer instance for chaining
     */
    useResourceMiddleware(middleware: ResourceMiddleware): this {
        this._middleware.useResourceMiddleware(middleware);
        return this;
    }

    /**
     * Registers middleware specifically for prompt requests.
     *
     * @param middleware - The prompt middleware function to register
     * @returns This McpServer instance for chaining
     */
    usePromptMiddleware(middleware: PromptMiddleware): this {
        this._middleware.usePromptMiddleware(middleware);
        return this;
    }

    /**
     * Gets the tool registry for advanced tool management.
     */
    get tools(): ToolRegistry {
        return this._toolRegistry;
    }

    /**
     * Gets the resource registry for advanced resource management.
     */
    get resources(): ResourceRegistry {
        return this._resourceRegistry;
    }

    /**
     * Gets the resource template registry for advanced template management.
     */
    get resourceTemplates(): ResourceTemplateRegistry {
        return this._resourceTemplateRegistry;
    }

    /**
     * Gets the prompt registry for advanced prompt management.
     */
    get prompts(): PromptRegistry {
        return this._promptRegistry;
    }

    /**
     * Creates a new McpServerBuilder for fluent configuration.
     *
     * @example
     * ```typescript
     * const server = McpServer.builder()
     *   .name('my-server')
     *   .version('1.0.0')
     *   .tool('greet', { name: z.string() }, async ({ name }) => ({
     *     content: [{ type: 'text', text: `Hello, ${name}!` }]
     *   }))
     *   .build();
     * ```
     */
    static builder(): McpServerBuilder {
        return new McpServerBuilder();
    }

    /**
     * Creates an McpServer from a BuilderResult configuration.
     *
     * @param result - The result from McpServerBuilder.build()
     * @returns A configured McpServer instance
     */
    static fromBuilderResult(result: BuilderResult): McpServer {
        // Create server with pre-populated registries from the builder
        // The constructor will bind notification callbacks to the registries
        const internalOptions: InternalMcpServerOptions = {
            ...result.options,
            _toolRegistry: result.registries.tools,
            _resourceRegistry: result.registries.resources,
            _promptRegistry: result.registries.prompts
        };

        const server = new McpServer(result.serverInfo, internalOptions);

        // Wire up error handlers
        if (result.errorHandlers.onError) {
            server.onError(result.errorHandlers.onError);
        }
        if (result.errorHandlers.onProtocolError) {
            server.onProtocolError(result.errorHandlers.onProtocolError);
        }

        // Apply global middleware from builder
        for (const middleware of result.middleware.universal) {
            server.useMiddleware(middleware);
        }
        for (const middleware of result.middleware.tool) {
            server.useToolMiddleware(middleware);
        }
        for (const middleware of result.middleware.resource) {
            server.useResourceMiddleware(middleware);
        }
        for (const middleware of result.middleware.prompt) {
            server.usePromptMiddleware(middleware);
        }

        // Apply per-item middleware
        for (const [name, middleware] of result.perItemMiddleware.tools) {
            server._middleware.useToolMiddlewareFor(name, middleware);
        }
        for (const [uri, middleware] of result.perItemMiddleware.resources) {
            server._middleware.useResourceMiddlewareFor(uri, middleware);
        }
        for (const [name, middleware] of result.perItemMiddleware.prompts) {
            server._middleware.usePromptMiddlewareFor(name, middleware);
        }

        return server;
    }

    /**
     * Access experimental features.
     *
     * WARNING: These APIs are experimental and may change without notice.
     *
     * @experimental
     */
    get experimental(): { tasks: ExperimentalMcpServerTasks } {
        if (!this._experimental) {
            this._experimental = {
                tasks: new ExperimentalMcpServerTasks(this)
            };
        }
        return this._experimental;
    }

    /**
     * Attaches to the given transport, starts it, and starts listening for messages.
     *
     * The `server` object assumes ownership of the Transport, replacing any callbacks that have already been set, and expects that it is the only user of the Transport instance going forward.
     */
    async connect(transport: Transport): Promise<void> {
        return await this.server.connect(transport);
    }

    /**
     * Closes the connection.
     */
    async close(): Promise<void> {
        await this.server.close();
    }

    private _toolHandlersInitialized = false;

    private setToolRequestHandlers() {
        if (this._toolHandlersInitialized) {
            return;
        }

        this.server.assertCanSetRequestHandler(getMethodValue(ListToolsRequestSchema));
        this.server.assertCanSetRequestHandler(getMethodValue(CallToolRequestSchema));

        this.server.registerCapabilities({
            tools: {
                listChanged: true
            }
        });

        this.server.setRequestHandler(
            ListToolsRequestSchema,
            (): ListToolsResult => ({
                tools: this._toolRegistry.getProtocolTools()
            })
        );

        this.server.setRequestHandler(CallToolRequestSchema, async (request, ctx): Promise<CallToolResult | CreateTaskResult> => {
            try {
                const tool = this._toolRegistry.getTool(request.params.name);
                if (!tool) {
                    throw ProtocolError.invalidParams(`Tool ${request.params.name} not found`);
                }
                if (!tool.enabled) {
                    throw ProtocolError.invalidParams(`Tool ${request.params.name} disabled`);
                }

                const isTaskRequest = !!request.params.task;
                const taskSupport = tool.execution?.taskSupport;
                const isTaskHandler = 'createTask' in (tool.handler as AnyToolHandler<ZodRawShapeCompat>);

                // Validate task hint configuration
                if ((taskSupport === 'required' || taskSupport === 'optional') && !isTaskHandler) {
                    throw ProtocolError.internalError(
                        `Tool ${request.params.name} has taskSupport '${taskSupport}' but was not registered with registerToolTask`
                    );
                }

                // Handle taskSupport 'required' without task augmentation
                if (taskSupport === 'required' && !isTaskRequest) {
                    throw ProtocolError.methodNotFound(`Tool ${request.params.name} requires task augmentation (taskSupport: 'required')`);
                }

                // Handle taskSupport 'optional' without task augmentation - automatic polling
                if (taskSupport === 'optional' && !isTaskRequest && isTaskHandler) {
                    return await this.handleAutomaticTaskPolling(tool, request, ctx);
                }

                // Build middleware context
                const middlewareCtx: ToolContext = {
                    type: 'tool',
                    requestId: String(ctx.mcpCtx.requestId),
                    authInfo: ctx.requestCtx.authInfo,
                    signal: ctx.requestCtx.signal,
                    name: request.params.name,
                    args: request.params.arguments
                };

                // Execute with middleware (including per-tool middleware if registered)
                const perToolMiddleware = this._middleware.getToolMiddlewareFor(request.params.name);
                const result = await this._middleware.executeToolMiddleware(
                    middlewareCtx,
                    async (mwCtx, modifiedArgs) => {
                        const argsToUse = modifiedArgs ?? mwCtx.args;
                        const validatedArgs = await this.validateToolInput(tool, argsToUse, request.params.name);
                        const handlerResult = await this.executeToolHandler(tool, validatedArgs, ctx);

                        // Return CreateTaskResult immediately for task requests
                        if (isTaskRequest) {
                            return handlerResult as CallToolResult;
                        }

                        // Validate output schema for non-task requests
                        await this.validateToolOutput(tool, handlerResult, request.params.name);
                        return handlerResult as CallToolResult;
                    },
                    perToolMiddleware
                );

                return result;
            } catch (error) {
                if (isProtocolError(error) && error.code === ErrorCode.UrlElicitationRequired) {
                    throw error; // Return the error to the caller without wrapping in CallToolResult
                }
                return this.createToolError(error instanceof Error ? error.message : String(error));
            }
        });

        this._toolHandlersInitialized = true;
    }

    /**
     * Creates a tool error result.
     *
     * @param errorMessage - The error message.
     * @returns The tool error result.
     */
    private createToolError(errorMessage: string): CallToolResult {
        return {
            content: [
                {
                    type: 'text',
                    text: errorMessage
                }
            ],
            isError: true
        };
    }

    /**
     * Validates tool input arguments against the tool's input schema.
     */
    private async validateToolInput<
        Tool extends RegisteredTool,
        Args extends Tool['inputSchema'] extends infer InputSchema
            ? InputSchema extends AnySchema
                ? SchemaOutput<InputSchema>
                : undefined
            : undefined
    >(tool: Tool, args: Args, toolName: string): Promise<Args> {
        if (!tool.inputSchema) {
            return undefined as Args;
        }

        // Try to normalize to object schema first (for raw shapes and object schemas)
        // If that fails, use the schema directly (for union/intersection/etc)
        const inputObj = normalizeObjectSchema(tool.inputSchema);
        const schemaToParse = inputObj ?? (tool.inputSchema as AnySchema);
        const parseResult = await safeParseAsync(schemaToParse, args);
        if (!parseResult.success) {
            const error = 'error' in parseResult ? parseResult.error : 'Unknown error';
            const errorMessage = getParseErrorMessage(error);
            throw ProtocolError.invalidParams(`Input validation error: Invalid arguments for tool ${toolName}: ${errorMessage}`);
        }

        return parseResult.data as unknown as Args;
    }

    /**
     * Validates tool output against the tool's output schema.
     */
    private async validateToolOutput(tool: RegisteredTool, result: CallToolResult | CreateTaskResult, toolName: string): Promise<void> {
        if (!tool.outputSchema) {
            return;
        }

        // Only validate CallToolResult, not CreateTaskResult
        if (!('content' in result)) {
            return;
        }

        if (result.isError) {
            return;
        }

        if (!result.structuredContent) {
            throw ProtocolError.invalidParams(
                `Output validation error: Tool ${toolName} has an output schema but no structured content was provided`
            );
        }

        // if the tool has an output schema, validate structured content
        const outputObj = normalizeObjectSchema(tool.outputSchema) as AnyObjectSchema;
        const parseResult = await safeParseAsync(outputObj, result.structuredContent);
        if (!parseResult.success) {
            const error = 'error' in parseResult ? parseResult.error : 'Unknown error';
            const errorMessage = getParseErrorMessage(error);
            throw ProtocolError.invalidParams(`Output validation error: Invalid structured content for tool ${toolName}: ${errorMessage}`);
        }
    }

    /**
     * Executes a tool handler (either regular or task-based).
     */
    private async executeToolHandler(
        tool: RegisteredTool,
        args: unknown,
        ctx: ServerContextInterface<ServerRequest, ServerNotification>
    ): Promise<CallToolResult | CreateTaskResult> {
        const handler = tool.handler as AnyToolHandler<ZodRawShapeCompat | undefined>;
        const isTaskHandler = 'createTask' in handler;

        if (isTaskHandler) {
            if (!ctx.taskCtx?.store) {
                throw new Error('No task store provided.');
            }
            const taskCtx = ctx;

            if (tool.inputSchema) {
                const typedHandler = handler as ToolTaskHandler<ZodRawShapeCompat>;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return await Promise.resolve(typedHandler.createTask(args as any, ctx));
            } else {
                const typedHandler = handler as ToolTaskHandler<undefined>;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return await Promise.resolve((typedHandler.createTask as any)(taskCtx));
            }
        }

        if (tool.inputSchema) {
            const typedHandler = handler as ToolCallback<ZodRawShapeCompat>;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return await Promise.resolve(typedHandler(args as any, ctx));
        } else {
            const typedHandler = handler as ToolCallback<undefined>;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return await Promise.resolve((typedHandler as any)(ctx));
        }
    }

    /**
     * Handles automatic task polling for tools with taskSupport 'optional'.
     */
    private async handleAutomaticTaskPolling<RequestT extends CallToolRequest>(
        tool: RegisteredTool,
        request: RequestT,
        ctx: ServerContextInterface<ServerRequest, ServerNotification>
    ): Promise<CallToolResult> {
        if (!ctx.taskCtx?.store) {
            throw new Error('No task store provided for task-capable tool.');
        }

        // Validate input and create task
        const args = await this.validateToolInput(tool, request.params.arguments, request.params.name);
        const handler = tool.handler as ToolTaskHandler<ZodRawShapeCompat | undefined>;

        const createTaskResult: CreateTaskResult = args // undefined only if tool.inputSchema is undefined
            ? await Promise.resolve((handler as ToolTaskHandler<ZodRawShapeCompat>).createTask(args, ctx))
            : // eslint-disable-next-line @typescript-eslint/no-explicit-any
              await Promise.resolve(((handler as ToolTaskHandler<undefined>).createTask as any)(ctx));

        // Poll until completion
        const taskId = createTaskResult.task.taskId;
        let task = createTaskResult.task;
        const pollInterval = task.pollInterval ?? 5000;

        while (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled') {
            await new Promise(resolve => setTimeout(resolve, pollInterval));
            const updatedTask = await ctx.taskCtx!.store.getTask(taskId);
            task = updatedTask;
        }

        // Return the final result
        return (await ctx.taskCtx!.store.getTaskResult(taskId)) as CallToolResult;
    }

    private _completionHandlerInitialized = false;

    private setCompletionRequestHandler() {
        if (this._completionHandlerInitialized) {
            return;
        }

        this.server.assertCanSetRequestHandler(getMethodValue(CompleteRequestSchema));

        this.server.registerCapabilities({
            completions: {}
        });

        this.server.setRequestHandler(CompleteRequestSchema, async (request): Promise<CompleteResult> => {
            switch (request.params.ref.type) {
                case 'ref/prompt': {
                    assertCompleteRequestPrompt(request);
                    return this.handlePromptCompletion(request, request.params.ref);
                }

                case 'ref/resource': {
                    assertCompleteRequestResourceTemplate(request);
                    return this.handleResourceCompletion(request, request.params.ref);
                }

                default: {
                    throw ProtocolError.invalidParams(`Invalid completion reference: ${request.params.ref}`);
                }
            }
        });

        this._completionHandlerInitialized = true;
    }

    private async handlePromptCompletion(request: CompleteRequestPrompt, ref: PromptReference): Promise<CompleteResult> {
        const prompt = this._promptRegistry.getPrompt(ref.name);
        if (!prompt) {
            throw ProtocolError.invalidParams(`Prompt ${ref.name} not found`);
        }

        if (!prompt.enabled) {
            throw ProtocolError.invalidParams(`Prompt ${ref.name} disabled`);
        }

        if (!prompt.argsSchema) {
            return EMPTY_COMPLETION_RESULT;
        }

        const promptShape = getObjectShape(prompt.argsSchema);
        const field = promptShape?.[request.params.argument.name];
        if (!isCompletable(field)) {
            return EMPTY_COMPLETION_RESULT;
        }

        const completer = getCompleter(field);
        if (!completer) {
            return EMPTY_COMPLETION_RESULT;
        }
        const suggestions = await completer(request.params.argument.value, request.params.context);
        return createCompletionResult(suggestions);
    }

    private async handleResourceCompletion(
        request: CompleteRequestResourceTemplate,
        ref: ResourceTemplateReference
    ): Promise<CompleteResult> {
        const template = this._resourceTemplateRegistry.values().find(t => t.template.uriTemplate.toString() === ref.uri);

        if (!template) {
            if (this._resourceRegistry.getResource(ref.uri)) {
                // Attempting to autocomplete a fixed resource URI is not an error in the spec (but probably should be).
                return EMPTY_COMPLETION_RESULT;
            }

            throw ProtocolError.invalidParams(`Resource template ${request.params.ref.uri} not found`);
        }

        const completer = template.template.completeCallback(request.params.argument.name);
        if (!completer) {
            return EMPTY_COMPLETION_RESULT;
        }

        const suggestions = await completer(request.params.argument.value, request.params.context);
        return createCompletionResult(suggestions);
    }

    private _resourceHandlersInitialized = false;

    private setResourceRequestHandlers() {
        if (this._resourceHandlersInitialized) {
            return;
        }

        this.server.assertCanSetRequestHandler(getMethodValue(ListResourcesRequestSchema));
        this.server.assertCanSetRequestHandler(getMethodValue(ListResourceTemplatesRequestSchema));
        this.server.assertCanSetRequestHandler(getMethodValue(ReadResourceRequestSchema));

        this.server.registerCapabilities({
            resources: {
                listChanged: true
            }
        });

        this.server.setRequestHandler(ListResourcesRequestSchema, async (request, ctx) => {
            const resources = this._resourceRegistry.getProtocolResources();

            const templateResources: Resource[] = [];
            for (const template of this._resourceTemplateRegistry.getEnabled()) {
                if (!template.template.listCallback) {
                    continue;
                }

                const result = await template.template.listCallback(ctx);
                for (const resource of result.resources) {
                    templateResources.push({
                        ...template.metadata,
                        // the defined resource metadata should override the template metadata if present
                        ...resource
                    });
                }
            }

            return { resources: [...resources, ...templateResources] };
        });

        this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
            resourceTemplates: this._resourceTemplateRegistry.getProtocolResourceTemplates()
        }));

        this.server.setRequestHandler(ReadResourceRequestSchema, async (request, ctx) => {
            const uri = new URL(request.params.uri);

            // First check for exact resource match
            const resource = this._resourceRegistry.getResource(uri.toString());
            if (resource) {
                if (!resource.enabled) {
                    throw ProtocolError.invalidParams(`Resource ${uri} disabled`);
                }

                // Build middleware context
                const middlewareCtx: ResourceContext = {
                    type: 'resource',
                    requestId: String(ctx.mcpCtx.requestId),
                    authInfo: ctx.requestCtx.authInfo,
                    signal: ctx.requestCtx.signal,
                    uri: uri.toString()
                };

                // Execute with middleware (including per-resource middleware if registered)
                const perResourceMiddleware = this._middleware.getResourceMiddlewareFor(uri.toString());
                return this._middleware.executeResourceMiddleware(
                    middlewareCtx,
                    async (mwCtx, modifiedUri) => {
                        const uriToUse = modifiedUri ? new URL(modifiedUri) : uri;
                        return resource.readCallback(uriToUse, ctx);
                    },
                    perResourceMiddleware
                );
            }

            // Then check templates
            const match = this._resourceTemplateRegistry.findMatchingTemplate(uri.toString());
            if (match) {
                // Build middleware context for template
                const middlewareCtx: ResourceContext = {
                    type: 'resource',
                    requestId: String(ctx.mcpCtx.requestId),
                    authInfo: ctx.requestCtx.authInfo,
                    signal: ctx.requestCtx.signal,
                    uri: uri.toString()
                };

                // Execute with middleware (templates don't have per-item middleware from builder)
                return this._middleware.executeResourceMiddleware(middlewareCtx, async () => {
                    return match.template.readCallback(uri, match.variables, ctx);
                });
            }

            throw ProtocolError.invalidParams(`Resource ${uri} not found`);
        });

        this._resourceHandlersInitialized = true;
    }

    private _promptHandlersInitialized = false;

    private setPromptRequestHandlers() {
        if (this._promptHandlersInitialized) {
            return;
        }

        this.server.assertCanSetRequestHandler(getMethodValue(ListPromptsRequestSchema));
        this.server.assertCanSetRequestHandler(getMethodValue(GetPromptRequestSchema));

        this.server.registerCapabilities({
            prompts: {
                listChanged: true
            }
        });

        this.server.setRequestHandler(
            ListPromptsRequestSchema,
            (): ListPromptsResult => ({
                prompts: this._promptRegistry.getProtocolPrompts()
            })
        );

        this.server.setRequestHandler(GetPromptRequestSchema, async (request, ctx): Promise<GetPromptResult> => {
            const prompt = this._promptRegistry.getPrompt(request.params.name);
            if (!prompt) {
                throw ProtocolError.invalidParams(`Prompt ${request.params.name} not found`);
            }

            if (!prompt.enabled) {
                throw ProtocolError.invalidParams(`Prompt ${request.params.name} disabled`);
            }

            // Build middleware context
            const middlewareCtx: PromptContext = {
                type: 'prompt',
                requestId: String(ctx.mcpCtx.requestId),
                authInfo: ctx.requestCtx.authInfo,
                signal: ctx.requestCtx.signal,
                name: request.params.name,
                args: request.params.arguments
            };

            // Execute with middleware (including per-prompt middleware if registered)
            const perPromptMiddleware = this._middleware.getPromptMiddlewareFor(request.params.name);
            return this._middleware.executePromptMiddleware(
                middlewareCtx,
                async (mwCtx, modifiedArgs) => {
                    const argsToUse = modifiedArgs ?? mwCtx.args;

                    if (prompt.argsSchema) {
                        const argsObj = normalizeObjectSchema(prompt.argsSchema) as AnyObjectSchema;
                        const parseResult = await safeParseAsync(argsObj, argsToUse);
                        if (!parseResult.success) {
                            const error = 'error' in parseResult ? parseResult.error : 'Unknown error';
                            const errorMessage = getParseErrorMessage(error);
                            throw ProtocolError.invalidParams(`Invalid arguments for prompt ${request.params.name}: ${errorMessage}`);
                        }

                        const args = parseResult.data;
                        const cb = prompt.callback as PromptCallback<PromptArgsRawShape>;
                        return await Promise.resolve(cb(args, ctx));
                    } else {
                        const cb = prompt.callback as PromptCallback<undefined>;
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        return await Promise.resolve((cb as any)(ctx));
                    }
                },
                perPromptMiddleware
            );
        });

        this._promptHandlersInitialized = true;
    }

    usePlugin(plugin: ProtocolPlugin<ServerResult>): this {
        this.server.usePlugin(plugin);
        return this;
    }

    /**
     * Registers a resource with a config object and callback.
     * For static resources, use a URI string. For dynamic resources, use a ResourceTemplate.
     */
    registerResource(
        name: string,
        uriOrTemplate: string,
        config: ResourceMetadata,
        readCallback: ReadResourceCallback
    ): RegisteredResourceEntity;
    registerResource(
        name: string,
        uriOrTemplate: ResourceTemplate,
        config: ResourceMetadata,
        readCallback: ReadResourceTemplateCallback
    ): RegisteredResourceTemplateEntity;
    registerResource(
        name: string,
        uriOrTemplate: string | ResourceTemplate,
        config: ResourceMetadata,
        readCallback: ReadResourceCallback | ReadResourceTemplateCallback
    ): RegisteredResourceEntity | RegisteredResourceTemplateEntity {
        if (typeof uriOrTemplate === 'string') {
            const registeredResource = this._resourceRegistry.register({
                name,
                uri: uriOrTemplate,
                title: (config as BaseMetadata).title,
                description: config.description,
                mimeType: config.mimeType,
                metadata: config,
                readCallback: readCallback as ReadResourceCallback
            });

            this.setResourceRequestHandlers();
            return registeredResource;
        } else {
            const registeredResourceTemplate = this._resourceTemplateRegistry.register({
                name,
                template: uriOrTemplate,
                title: (config as BaseMetadata).title,
                description: config.description,
                mimeType: config.mimeType,
                metadata: config,
                readCallback: readCallback as ReadResourceTemplateCallback
            });

            this.setResourceRequestHandlers();

            // If the resource template has any completion callbacks, enable completions capability
            const variableNames = uriOrTemplate.uriTemplate.variableNames;
            const hasCompleter = Array.isArray(variableNames) && variableNames.some(v => !!uriOrTemplate.completeCallback(v));
            if (hasCompleter) {
                this.setCompletionRequestHandler();
            }

            return registeredResourceTemplate;
        }
    }

    /**
     * Registers a tool with a config object and callback.
     */
    registerTool<OutputArgs extends ZodRawShapeCompat | AnySchema, InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined>(
        name: string,
        config: {
            title?: string;
            description?: string;
            inputSchema?: InputArgs;
            outputSchema?: OutputArgs;
            annotations?: ToolAnnotations;
            execution?: ToolExecution;
            _meta?: Record<string, unknown>;
        },
        cb: ToolCallback<InputArgs>
    ): RegisteredTool {
        const { title, description, inputSchema, outputSchema, annotations, execution, _meta } = config;

        const registeredTool = this._toolRegistry.register({
            name,
            title,
            description,
            inputSchema: getZodSchemaObject(inputSchema),
            outputSchema: getZodSchemaObject(outputSchema),
            annotations,
            execution: execution ?? { taskSupport: 'forbidden' },
            _meta,
            handler: cb as ToolCallback<ZodRawShapeCompat | undefined>
        });

        this.setToolRequestHandlers();
        return registeredTool;
    }

    /**
     * Registers a prompt with a config object and callback.
     */
    registerPrompt<Args extends undefined | PromptArgsRawShape = undefined>(
        name: string,
        config: {
            title?: string;
            description?: string;
            argsSchema?: Args;
        },
        cb: PromptCallback<Args>
    ): RegisteredPrompt {
        const { title, description, argsSchema } = config;

        const registeredPrompt = this._promptRegistry.register({
            name,
            title,
            description,
            argsSchema,
            callback: cb as PromptCallback<PromptArgsRawShape | undefined>
        });

        this.setPromptRequestHandlers();

        // If any argument uses a Completable schema, enable completions capability
        if (argsSchema) {
            const hasCompletable = Object.values(argsSchema).some(field => {
                const inner: unknown = field instanceof ZodOptional ? field._def?.innerType : field;
                return isCompletable(inner);
            });
            if (hasCompletable) {
                this.setCompletionRequestHandler();
            }
        }

        return registeredPrompt;
    }

    /**
     * Checks if the server is connected to a transport.
     * @returns True if the server is connected
     */
    isConnected() {
        return this.server.transport !== undefined;
    }

    /**
     * Sends a logging message to the client, if connected.
     * Note: You only need to send the parameters object, not the entire JSON RPC message
     * @see LoggingMessageNotification
     * @param params
     * @param sessionId optional for stateless and backward compatibility
     */
    async sendLoggingMessage(params: LoggingMessageNotification['params'], sessionId?: string) {
        return this.server.sendLoggingMessage(params, sessionId);
    }
    /**
     * Sends a resource list changed event to the client, if connected.
     */
    sendResourceListChanged() {
        if (this.isConnected()) {
            this.server.sendResourceListChanged();
        }
    }

    /**
     * Sends a tool list changed event to the client, if connected.
     */
    sendToolListChanged() {
        if (this.isConnected()) {
            this.server.sendToolListChanged();
        }
    }

    /**
     * Sends a prompt list changed event to the client, if connected.
     */
    sendPromptListChanged() {
        if (this.isConnected()) {
            this.server.sendPromptListChanged();
        }
    }

    /**
     * Updates the error interceptor on the underlying Server based on current handlers.
     * This combines both onError and onProtocolError handlers into a single interceptor.
     */
    private _updateErrorInterceptor(): void {
        if (!this._onErrorHandler && !this._onProtocolErrorHandler) {
            // No handlers, clear the interceptor
            this.server.setErrorInterceptor(undefined);
            return;
        }

        this.server.setErrorInterceptor(async (error: Error, ctx: ErrorInterceptionContext): Promise<ErrorInterceptionResult | void> => {
            const errorContext: ErrorContext = {
                type: ctx.type === 'protocol' ? 'protocol' : 'tool', // Map to ErrorContext type
                method: ctx.method,
                requestId: typeof ctx.requestId === 'string' ? ctx.requestId : String(ctx.requestId)
            };

            let result: OnErrorReturn | OnProtocolErrorReturn | void = undefined;

            if (ctx.type === 'protocol' && this._onProtocolErrorHandler) {
                // Protocol error - use onProtocolError handler
                result = await this._onProtocolErrorHandler(error, errorContext);
            } else if (this._onErrorHandler) {
                // Application error (or protocol error without specific handler) - use onError handler
                result = await this._onErrorHandler(error, errorContext);
            }

            if (result === undefined || result === null) {
                return undefined;
            }

            // Convert the handler result to ErrorInterceptionResult
            if (typeof result === 'string') {
                return { message: result };
            } else if (result instanceof Error) {
                const errorWithCode = result as Error & { code?: number; data?: unknown };
                return {
                    message: result.message,
                    code: ctx.type === 'application' ? errorWithCode.code : undefined,
                    data: errorWithCode.data
                };
            } else {
                // Object with code/message/data
                return {
                    message: result.message,
                    code: ctx.type === 'application' ? (result as OnErrorReturn & { code?: number }).code : undefined,
                    data: result.data
                };
            }
        });
    }

    /**
     * Registers an error handler for application errors in tool/resource/prompt handlers.
     *
     * The handler receives the error and a context object with information about where
     * the error occurred. It can optionally return a custom error response that will
     * modify the error sent to the client.
     *
     * Note: This is a single-handler pattern. Setting a new handler replaces any previous one.
     * The handler is awaited, so async handlers are fully supported.
     *
     * @param handler - Error handler function
     * @returns Unsubscribe function
     *
     * @example
     * ```typescript
     * const unsubscribe = server.onError(async (error, ctx) => {
     *   console.error(`Error in ${ctx.type}/${ctx.method}: ${error.message}`);
     *   // Optionally return a custom error response
     *   return {
     *     code: -32000,
     *     message: `Application error: ${error.message}`,
     *     data: { type: ctx.type }
     *   };
     * });
     * ```
     */
    onError(handler: OnErrorHandler): () => void {
        this._onErrorHandler = handler;
        this._updateErrorInterceptor();
        return this._clearOnErrorHandler.bind(this);
    }

    private _clearOnErrorHandler(): void {
        this._onErrorHandler = undefined;
        this._updateErrorInterceptor();
    }

    /**
     * Registers an error handler for protocol errors (method not found, parse error, etc.).
     *
     * The handler receives the error and a context object. It can optionally return
     * a custom error response. Note that the error code cannot be changed for protocol
     * errors as they have fixed codes per the MCP specification.
     *
     * Note: This is a single-handler pattern. Setting a new handler replaces any previous one.
     * The handler is awaited, so async handlers are fully supported.
     *
     * @param handler - Error handler function
     * @returns Unsubscribe function
     *
     * @example
     * ```typescript
     * const unsubscribe = server.onProtocolError(async (error, ctx) => {
     *   console.error(`Protocol error in ${ctx.method}: ${error.message}`);
     *   return { message: `Protocol error: ${error.message}` };
     * });
     * ```
     */
    onProtocolError(handler: OnProtocolErrorHandler): () => void {
        this._onProtocolErrorHandler = handler;
        this._updateErrorInterceptor();
        return this._clearOnProtocolErrorHandler.bind(this);
    }

    private _clearOnProtocolErrorHandler(): void {
        this._onProtocolErrorHandler = undefined;
        this._updateErrorInterceptor();
    }
}

/**
 * A callback to complete one variable within a resource template's URI template.
 */
export type CompleteResourceTemplateCallback = (
    value: string,
    context?: {
        arguments?: Record<string, string>;
    }
) => string[] | Promise<string[]>;

/**
 * A resource template combines a URI pattern with optional functionality to enumerate
 * all resources matching that pattern.
 */
export class ResourceTemplate {
    private _uriTemplate: UriTemplate;

    constructor(
        uriTemplate: string | UriTemplate,
        private _callbacks: {
            /**
             * A callback to list all resources matching this template. This is required to specified, even if `undefined`, to avoid accidentally forgetting resource listing.
             */
            list: ListResourcesCallback | undefined;

            /**
             * An optional callback to autocomplete variables within the URI template. Useful for clients and users to discover possible values.
             */
            complete?: {
                [variable: string]: CompleteResourceTemplateCallback;
            };
        }
    ) {
        this._uriTemplate = typeof uriTemplate === 'string' ? new UriTemplate(uriTemplate) : uriTemplate;
    }

    /**
     * Gets the URI template pattern.
     */
    get uriTemplate(): UriTemplate {
        return this._uriTemplate;
    }

    /**
     * Gets the list callback, if one was provided.
     */
    get listCallback(): ListResourcesCallback | undefined {
        return this._callbacks.list;
    }

    /**
     * Gets the callback for completing a specific URI template variable, if one was provided.
     */
    completeCallback(variable: string): CompleteResourceTemplateCallback | undefined {
        return this._callbacks.complete?.[variable];
    }
}

export type BaseToolCallback<
    SendResultT extends Result,
    Extra extends ServerContextInterface<ServerRequest, ServerNotification>,
    Args extends undefined | ZodRawShapeCompat | AnySchema
> = Args extends ZodRawShapeCompat
    ? (args: ShapeOutput<Args>, ctx: Extra) => SendResultT | Promise<SendResultT>
    : Args extends AnySchema
      ? (args: SchemaOutput<Args>, ctx: Extra) => SendResultT | Promise<SendResultT>
      : (ctx: Extra) => SendResultT | Promise<SendResultT>;

/**
 * Callback for a tool handler registered with Server.tool().
 *
 * Parameters will include tool arguments, if applicable, as well as other request handler context.
 *
 * The callback should return:
 * - `structuredContent` if the tool has an outputSchema defined
 * - `content` if the tool does not have an outputSchema
 * - Both fields are optional but typically one should be provided
 */
export type ToolCallback<Args extends undefined | ZodRawShapeCompat | AnySchema = undefined> = BaseToolCallback<
    CallToolResult,
    ServerContextInterface<ServerRequest, ServerNotification>,
    Args
>;

/**
 * Supertype that can handle both regular tools (simple callback) and task-based tools (task handler object).
 */
export type AnyToolHandler<Args extends undefined | ZodRawShapeCompat | AnySchema = undefined> = ToolCallback<Args> | ToolTaskHandler<Args>;

/**
 * Checks if a value looks like a Zod schema by checking for parse/safeParse methods.
 */
function isZodTypeLike(value: unknown): value is AnySchema {
    return (
        value !== null &&
        typeof value === 'object' &&
        'parse' in value &&
        typeof value.parse === 'function' &&
        'safeParse' in value &&
        typeof value.safeParse === 'function'
    );
}

/**
 * Checks if an object is a Zod schema instance (v3 or v4).
 *
 * Zod schemas have internal markers:
 * - v3: `_def` property
 * - v4: `_zod` property
 *
 * This includes transformed schemas like z.preprocess(), z.transform(), z.pipe().
 */
function isZodSchemaInstance(obj: object): boolean {
    return '_def' in obj || '_zod' in obj || isZodTypeLike(obj);
}

/**
 * Checks if an object is a "raw shape" - a plain object where values are Zod schemas.
 *
 * Raw shapes are used as shorthand: `{ name: z.string() }` instead of `z.object({ name: z.string() })`.
 *
 * IMPORTANT: This must NOT match actual Zod schema instances (like z.preprocess, z.pipe),
 * which have internal properties that could be mistaken for schema values.
 */
function isZodRawShapeCompat(obj: unknown): obj is ZodRawShapeCompat {
    if (typeof obj !== 'object' || obj === null) {
        return false;
    }

    // If it's already a Zod schema instance, it's NOT a raw shape
    if (isZodSchemaInstance(obj)) {
        return false;
    }

    // Empty objects are valid raw shapes (tools with no parameters)
    if (Object.keys(obj).length === 0) {
        return true;
    }

    // A raw shape has at least one property that is a Zod schema
    return Object.values(obj).some(element => isZodTypeLike(element));
}

/**
 * Converts a provided Zod schema to a Zod object if it is a ZodRawShapeCompat,
 * otherwise returns the schema as is.
 */
function getZodSchemaObject(schema: ZodRawShapeCompat | AnySchema | undefined): AnySchema | undefined {
    if (!schema) {
        return undefined;
    }

    if (isZodRawShapeCompat(schema)) {
        return objectFromShape(schema);
    }

    return schema;
}

/**
 * Additional, optional information for annotating a resource.
 */
export type ResourceMetadata = Omit<Resource, 'uri' | 'name'>;

/**
 * Callback to list all resources matching a given template.
 */
export type ListResourcesCallback = (
    ctx: ServerContextInterface<ServerRequest, ServerNotification>
) => ListResourcesResult | Promise<ListResourcesResult>;

function getMethodValue(schema: AnyObjectSchema): string {
    const shape = getObjectShape(schema);
    const methodSchema = shape?.method as AnySchema | undefined;
    if (!methodSchema) {
        throw new Error('Schema is missing a method literal');
    }

    // Extract literal value - works for both v3 and v4
    const value = getLiteralValue(methodSchema);
    if (typeof value === 'string') {
        return value;
    }

    throw new Error('Schema method literal must be a string');
}

function createCompletionResult(suggestions: string[]): CompleteResult {
    return {
        completion: {
            values: suggestions.slice(0, 100),
            total: suggestions.length,
            hasMore: suggestions.length > 100
        }
    };
}

const EMPTY_COMPLETION_RESULT: CompleteResult = {
    completion: {
        values: [],
        hasMore: false
    }
};
