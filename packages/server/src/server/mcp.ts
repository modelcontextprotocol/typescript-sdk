import type {
    AnySchema,
    BaseMetadata,
    CallToolRequest,
    CallToolResult,
    CompleteRequestPrompt,
    CompleteRequestResourceTemplate,
    CompleteResult,
    CreateTaskResult,
    GetPromptResult,
    Implementation,
    ListPromptsResult,
    ListToolsResult,
    LoggingMessageNotification,
    PromptReference,
    Resource,
    ResourceTemplateReference,
    SchemaOutput,
    ServerContext,
    ToolAnnotations,
    ToolExecution,
    Transport
} from '@modelcontextprotocol/core';
import {
    assertCompleteRequestPrompt,
    assertCompleteRequestResourceTemplate,
    getSchemaShape,
    parseSchemaAsync,
    ProtocolError,
    ProtocolErrorCode,
    unwrapOptionalSchema
} from '@modelcontextprotocol/core';

import { ExperimentalMcpServerTasks } from '../experimental/tasks/mcpServer.js';
import { getCompleter, isCompletable } from './completable.js';
import type {
    AnyToolHandler,
    PromptCallback,
    ReadResourceCallback,
    ReadResourceTemplateCallback,
    ResourceMetadata,
    ResourceTemplate,
    ToolCallback
} from './primitives/index.js';
import { RegisteredPrompt, RegisteredResource, RegisteredResourceTemplate, RegisteredTool } from './primitives/index.js';
import type { ServerOptions } from './server.js';
import { Server } from './server.js';

/**
 * High-level MCP server that provides a simpler API for working with resources, tools, and prompts.
 * For advanced usage (like sending notifications or setting custom request handlers), use the underlying
 * {@linkcode Server} instance available via the {@linkcode McpServer.server | server} property.
 *
 * @example
 * ```ts source="./mcp.examples.ts#McpServer_basicUsage"
 * const server = new McpServer({
 *     name: 'my-server',
 *     version: '1.0.0'
 * });
 * ```
 */
export class McpServer {
    /**
     * The underlying {@linkcode Server} instance, useful for advanced operations like sending notifications.
     */
    public readonly server: Server;

    private _registeredResources: { [uri: string]: RegisteredResource } = {};
    private _registeredResourceTemplates: {
        [name: string]: RegisteredResourceTemplate;
    } = {};
    private _registeredTools: { [name: string]: RegisteredTool } = {};
    private _registeredPrompts: { [name: string]: RegisteredPrompt } = {};
    private _experimental?: { tasks: ExperimentalMcpServerTasks };

    constructor(serverInfo: Implementation, options?: ServerOptions) {
        this.server = new Server(serverInfo, options);
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
     * Gets all registered tools.
     * @returns A read-only map of tool names to RegisteredTool instances
     */
    get tools(): ReadonlyMap<string, RegisteredTool> {
        return new Map(Object.entries(this._registeredTools));
    }

    /**
     * Gets all registered prompts.
     * @returns A read-only map of prompt names to RegisteredPrompt instances
     */
    get prompts(): ReadonlyMap<string, RegisteredPrompt> {
        return new Map(Object.entries(this._registeredPrompts));
    }

    /**
     * Gets all registered resources.
     * @returns A read-only map of resource URIs to RegisteredResource instances
     */
    get resources(): ReadonlyMap<string, RegisteredResource> {
        return new Map(Object.entries(this._registeredResources));
    }

    /**
     * Gets all registered resource templates.
     * @returns A read-only map of template names to RegisteredResourceTemplate instances
     */
    get resourceTemplates(): ReadonlyMap<string, RegisteredResourceTemplate> {
        return new Map(Object.entries(this._registeredResourceTemplates));
    }

    /**
     * Attaches to the given transport, starts it, and starts listening for messages.
     *
     * The `server` object assumes ownership of the {@linkcode Transport}, replacing any callbacks that have already been set, and expects that it is the only user of the {@linkcode Transport} instance going forward.
     *
     * @example
     * ```ts source="./mcp.examples.ts#McpServer_connect_stdio"
     * const server = new McpServer({ name: 'my-server', version: '1.0.0' });
     * const transport = new StdioServerTransport();
     * await server.connect(transport);
     * ```
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

        this.server.assertCanSetRequestHandler('tools/list');
        this.server.assertCanSetRequestHandler('tools/call');

        this.server.registerCapabilities({
            tools: {
                listChanged: this.server.getCapabilities().tools?.listChanged ?? true
            }
        });

        this.server.setRequestHandler(
            'tools/list',
            (): ListToolsResult => ({
                tools: Object.values(this._registeredTools)
                    .filter(tool => tool.enabled)
                    .map(tool => tool.toProtocolTool())
            })
        );

        this.server.setRequestHandler('tools/call', async (request, ctx): Promise<CallToolResult | CreateTaskResult> => {
            try {
                const tool = this._registeredTools[request.params.name];
                if (!tool) {
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
                }
                if (!tool.enabled) {
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${request.params.name} disabled`);
                }

                const isTaskRequest = !!request.params.task;
                const taskSupport = tool.execution?.taskSupport;
                const isTaskHandler = 'createTask' in (tool.handler as AnyToolHandler<AnySchema>);

                // Validate task hint configuration
                if ((taskSupport === 'required' || taskSupport === 'optional') && !isTaskHandler) {
                    throw new ProtocolError(
                        ProtocolErrorCode.InternalError,
                        `Tool ${request.params.name} has taskSupport '${taskSupport}' but was not registered with registerToolTask`
                    );
                }

                // Handle taskSupport 'required' without task augmentation
                if (taskSupport === 'required' && !isTaskRequest) {
                    throw new ProtocolError(
                        ProtocolErrorCode.MethodNotFound,
                        `Tool ${request.params.name} requires task augmentation (taskSupport: 'required')`
                    );
                }

                // Handle taskSupport 'optional' without task augmentation - automatic polling
                if (taskSupport === 'optional' && !isTaskRequest && isTaskHandler) {
                    return await this.handleAutomaticTaskPolling(tool, request, ctx);
                }

                // Normal execution path
                const args = await this.validateToolInput(tool, request.params.arguments, request.params.name);
                const result = await this.executeToolHandler(tool, args, ctx);

                // Return CreateTaskResult immediately for task requests
                if (isTaskRequest) {
                    return result;
                }

                // Validate output schema for non-task requests
                await this.validateToolOutput(tool, result, request.params.name);
                return result;
            } catch (error) {
                if (error instanceof ProtocolError && error.code === ProtocolErrorCode.UrlElicitationRequired) {
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

        const parseResult = await parseSchemaAsync(tool.inputSchema, args ?? {});
        if (!parseResult.success) {
            const errorMessage = parseResult.error.issues.map((i: { message: string }) => i.message).join(', ');
            throw new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                `Input validation error: Invalid arguments for tool ${toolName}: ${errorMessage}`
            );
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
            throw new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                `Output validation error: Tool ${toolName} has an output schema but no structured content was provided`
            );
        }

        // if the tool has an output schema, validate structured content
        const parseResult = await parseSchemaAsync(tool.outputSchema, result.structuredContent);
        if (!parseResult.success) {
            const errorMessage = parseResult.error.issues.map((i: { message: string }) => i.message).join(', ');
            throw new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                `Output validation error: Invalid structured content for tool ${toolName}: ${errorMessage}`
            );
        }
    }

    /**
     * Executes a tool handler (either regular or task-based).
     */
    private async executeToolHandler(tool: RegisteredTool, args: unknown, ctx: ServerContext): Promise<CallToolResult | CreateTaskResult> {
        // Executor encapsulates handler invocation with proper types
        return tool.executor(args, ctx);
    }

    /**
     * Handles automatic task polling for tools with `taskSupport` `'optional'`.
     */
    private async handleAutomaticTaskPolling<RequestT extends CallToolRequest>(
        tool: RegisteredTool,
        request: RequestT,
        ctx: ServerContext
    ): Promise<CallToolResult> {
        if (!ctx.task?.store) {
            throw new Error('No task store provided for task-capable tool.');
        }

        // Validate input and create task using the executor
        const args = await this.validateToolInput(tool, request.params.arguments, request.params.name);
        const createTaskResult = (await tool.executor(args, ctx)) as CreateTaskResult;

        // Poll until completion
        const taskId = createTaskResult.task.taskId;
        let task = createTaskResult.task;
        const pollInterval = task.pollInterval ?? 5000;

        while (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled') {
            await new Promise(resolve => setTimeout(resolve, pollInterval));
            const updatedTask = await ctx.task.store.getTask(taskId);
            if (!updatedTask) {
                throw new ProtocolError(ProtocolErrorCode.InternalError, `Task ${taskId} not found during polling`);
            }
            task = updatedTask;
        }

        // Return the final result
        return (await ctx.task.store.getTaskResult(taskId)) as CallToolResult;
    }

    private _completionHandlerInitialized = false;

    private setCompletionRequestHandler() {
        if (this._completionHandlerInitialized) {
            return;
        }

        this.server.assertCanSetRequestHandler('completion/complete');

        this.server.registerCapabilities({
            completions: {}
        });

        this.server.setRequestHandler('completion/complete', async (request): Promise<CompleteResult> => {
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
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid completion reference: ${request.params.ref}`);
                }
            }
        });

        this._completionHandlerInitialized = true;
    }

    private async handlePromptCompletion(request: CompleteRequestPrompt, ref: PromptReference): Promise<CompleteResult> {
        const prompt = this._registeredPrompts[ref.name];
        if (!prompt) {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Prompt ${ref.name} not found`);
        }

        if (!prompt.enabled) {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Prompt ${ref.name} disabled`);
        }

        if (!prompt.argsSchema) {
            return EMPTY_COMPLETION_RESULT;
        }

        const promptShape = getSchemaShape(prompt.argsSchema);
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
        const template = Object.values(this._registeredResourceTemplates).find(t => t.resourceTemplate.uriTemplate.toString() === ref.uri);

        if (!template) {
            if (this._registeredResources[ref.uri]) {
                // Attempting to autocomplete a fixed resource URI is not an error in the spec (but probably should be).
                return EMPTY_COMPLETION_RESULT;
            }

            throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource template ${request.params.ref.uri} not found`);
        }

        const completer = template.resourceTemplate.completeCallback(request.params.argument.name);
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

        this.server.assertCanSetRequestHandler('resources/list');
        this.server.assertCanSetRequestHandler('resources/templates/list');
        this.server.assertCanSetRequestHandler('resources/read');

        this.server.registerCapabilities({
            resources: {
                listChanged: this.server.getCapabilities().resources?.listChanged ?? true
            }
        });

        this.server.setRequestHandler('resources/list', async (_request, ctx) => {
            const resources = Object.values(this._registeredResources)
                .filter(resource => resource.enabled)
                .map(resource => resource.toProtocolResource());

            const templateResources: Resource[] = [];
            for (const template of Object.values(this._registeredResourceTemplates)) {
                if (!template.resourceTemplate.listCallback) {
                    continue;
                }

                const result = await template.resourceTemplate.listCallback(ctx);
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

        this.server.setRequestHandler('resources/templates/list', async () => {
            const resourceTemplates = Object.values(this._registeredResourceTemplates).map(template =>
                template.toProtocolResourceTemplate()
            );

            return { resourceTemplates };
        });

        this.server.setRequestHandler('resources/read', async (request, ctx) => {
            const uri = new URL(request.params.uri);

            // First check for exact resource match
            const resource = this._registeredResources[uri.toString()];
            if (resource) {
                if (!resource.enabled) {
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource ${uri} disabled`);
                }
                return resource.readCallback(uri, ctx);
            }

            // Then check templates
            for (const template of Object.values(this._registeredResourceTemplates)) {
                const variables = template.resourceTemplate.uriTemplate.match(uri.toString());
                if (variables) {
                    return template.readCallback(uri, variables, ctx);
                }
            }

            throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource ${uri} not found`);
        });

        this._resourceHandlersInitialized = true;
    }

    private _promptHandlersInitialized = false;

    private setPromptRequestHandlers() {
        if (this._promptHandlersInitialized) {
            return;
        }

        this.server.assertCanSetRequestHandler('prompts/list');
        this.server.assertCanSetRequestHandler('prompts/get');

        this.server.registerCapabilities({
            prompts: {
                listChanged: this.server.getCapabilities().prompts?.listChanged ?? true
            }
        });

        this.server.setRequestHandler(
            'prompts/list',
            (): ListPromptsResult => ({
                prompts: Object.values(this._registeredPrompts)
                    .filter(prompt => prompt.enabled)
                    .map(prompt => prompt.toProtocolPrompt())
            })
        );

        this.server.setRequestHandler('prompts/get', async (request, ctx): Promise<GetPromptResult> => {
            const prompt = this._registeredPrompts[request.params.name];
            if (!prompt) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Prompt ${request.params.name} not found`);
            }

            if (!prompt.enabled) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Prompt ${request.params.name} disabled`);
            }

            // Handler encapsulates parsing and callback invocation with proper types
            return prompt.handler(request.params.arguments, ctx);
        });

        this._promptHandlersInitialized = true;
    }

    /**
     * Registers a resource with a config object and callback.
     * For static resources, use a URI string. For dynamic resources, use a {@linkcode ResourceTemplate}.
     *
     * @example
     * ```ts source="./mcp.examples.ts#McpServer_registerResource_static"
     * server.registerResource(
     *     'config',
     *     'config://app',
     *     {
     *         title: 'Application Config',
     *         mimeType: 'text/plain'
     *     },
     *     async uri => ({
     *         contents: [{ uri: uri.href, text: 'App configuration here' }]
     *     })
     * );
     * ```
     */
    registerResource(name: string, uriOrTemplate: string, config: ResourceMetadata, readCallback: ReadResourceCallback): RegisteredResource;
    registerResource(
        name: string,
        uriOrTemplate: ResourceTemplate,
        config: ResourceMetadata,
        readCallback: ReadResourceTemplateCallback
    ): RegisteredResourceTemplate;
    registerResource(
        name: string,
        uriOrTemplate: string | ResourceTemplate,
        config: ResourceMetadata,
        readCallback: ReadResourceCallback | ReadResourceTemplateCallback
    ): RegisteredResource | RegisteredResourceTemplate {
        if (typeof uriOrTemplate === 'string') {
            if (this._registeredResources[uriOrTemplate]) {
                throw new Error(`Resource ${uriOrTemplate} is already registered`);
            }

            const registeredResource = this._createRegisteredResource(
                name,
                (config as BaseMetadata).title,
                uriOrTemplate,
                config,
                readCallback as ReadResourceCallback
            );

            this.setResourceRequestHandlers();
            this.sendResourceListChanged();
            return registeredResource;
        } else {
            if (this._registeredResourceTemplates[name]) {
                throw new Error(`Resource template ${name} is already registered`);
            }

            const registeredResourceTemplate = this._createRegisteredResourceTemplate(
                name,
                (config as BaseMetadata).title,
                uriOrTemplate,
                config,
                readCallback as ReadResourceTemplateCallback
            );

            this.setResourceRequestHandlers();
            this.sendResourceListChanged();
            return registeredResourceTemplate;
        }
    }

    private _createRegisteredResource(
        name: string,
        title: string | undefined,
        uri: string,
        metadata: ResourceMetadata | undefined,
        readCallback: ReadResourceCallback
    ): RegisteredResource {
        const resource = new RegisteredResource(
            {
                name,
                title,
                uri,
                ...metadata,
                readCallback
            },
            () => this.sendResourceListChanged(),
            (oldUri, newUri, r) => {
                delete this._registeredResources[oldUri];
                this._registeredResources[newUri] = r;
                this.sendResourceListChanged();
            },
            resourceUri => {
                delete this._registeredResources[resourceUri];
                this.sendResourceListChanged();
            }
        );
        this._registeredResources[uri] = resource;
        return resource;
    }

    private _createRegisteredResourceTemplate(
        name: string,
        title: string | undefined,
        template: ResourceTemplate,
        metadata: ResourceMetadata | undefined,
        readCallback: ReadResourceTemplateCallback
    ): RegisteredResourceTemplate {
        const resourceTemplate = new RegisteredResourceTemplate(
            {
                name,
                title,
                resourceTemplate: template,
                ...metadata,
                readCallback
            },
            () => this.sendResourceListChanged(),
            (oldName, newName, rt) => {
                delete this._registeredResourceTemplates[oldName];
                this._registeredResourceTemplates[newName] = rt;
                this.sendResourceListChanged();
            },
            templateName => {
                delete this._registeredResourceTemplates[templateName];
                this.sendResourceListChanged();
            }
        );
        this._registeredResourceTemplates[name] = resourceTemplate;

        // If the resource template has any completion callbacks, enable completions capability
        const variableNames = template.uriTemplate.variableNames;
        const hasCompleter = Array.isArray(variableNames) && variableNames.some(v => !!template.completeCallback(v));
        if (hasCompleter) {
            this.setCompletionRequestHandler();
        }

        return resourceTemplate;
    }

    private _createRegisteredPrompt(
        name: string,
        title: string | undefined,
        description: string | undefined,
        argsSchema: AnySchema | undefined,
        callback: PromptCallback<AnySchema | undefined>
    ): RegisteredPrompt {
        const prompt = new RegisteredPrompt(
            {
                name,
                title,
                description,
                argsSchema,
                callback
            },
            () => this.sendPromptListChanged(),
            (oldName, newName, p) => {
                delete this._registeredPrompts[oldName];
                this._registeredPrompts[newName] = p;
                this.sendPromptListChanged();
            },
            promptName => {
                delete this._registeredPrompts[promptName];
                this.sendPromptListChanged();
            }
        );
        this._registeredPrompts[name] = prompt;

        // If any argument uses a Completable schema, enable completions capability
        if (argsSchema) {
            const shape = getSchemaShape(argsSchema);
            if (shape) {
                const hasCompletable = Object.values(shape).some(field => {
                    const inner = unwrapOptionalSchema(field);
                    return isCompletable(inner);
                });
                if (hasCompletable) {
                    this.setCompletionRequestHandler();
                }
            }
        }

        return prompt;
    }

    private _createRegisteredTool(
        name: string,
        title: string | undefined,
        description: string | undefined,
        inputSchema: AnySchema | undefined,
        outputSchema: AnySchema | undefined,
        annotations: ToolAnnotations | undefined,
        execution: ToolExecution | undefined,
        _meta: Record<string, unknown> | undefined,
        handler: AnyToolHandler<AnySchema | undefined>
    ): RegisteredTool {
        const tool = new RegisteredTool(
            {
                name,
                title,
                description,
                inputSchema,
                outputSchema,
                annotations,
                execution,
                _meta,
                handler
            },
            () => this.sendToolListChanged(),
            (oldName, newName, t) => {
                delete this._registeredTools[oldName];
                this._registeredTools[newName] = t;
                this.sendToolListChanged();
            },
            toolName => {
                delete this._registeredTools[toolName];
                this.sendToolListChanged();
            }
        );
        this._registeredTools[name] = tool;

        this.setToolRequestHandlers();
        this.sendToolListChanged();

        return tool;
    }

    /**
     * Registers a tool with a config object and callback.
     *
     * @example
     * ```ts source="./mcp.examples.ts#McpServer_registerTool_basic"
     * server.registerTool(
     *     'calculate-bmi',
     *     {
     *         title: 'BMI Calculator',
     *         description: 'Calculate Body Mass Index',
     *         inputSchema: z.object({
     *             weightKg: z.number(),
     *             heightM: z.number()
     *         }),
     *         outputSchema: z.object({ bmi: z.number() })
     *     },
     *     async ({ weightKg, heightM }) => {
     *         const output = { bmi: weightKg / (heightM * heightM) };
     *         return {
     *             content: [{ type: 'text', text: JSON.stringify(output) }],
     *             structuredContent: output
     *         };
     *     }
     * );
     * ```
     */
    registerTool<OutputArgs extends AnySchema, InputArgs extends AnySchema | undefined = undefined>(
        name: string,
        config: {
            title?: string;
            description?: string;
            inputSchema?: InputArgs;
            outputSchema?: OutputArgs;
            annotations?: ToolAnnotations;
            _meta?: Record<string, unknown>;
        },
        cb: ToolCallback<InputArgs>
    ): RegisteredTool {
        if (this._registeredTools[name]) {
            throw new Error(`Tool ${name} is already registered`);
        }

        const { title, description, inputSchema, outputSchema, annotations, _meta } = config;

        return this._createRegisteredTool(
            name,
            title,
            description,
            inputSchema,
            outputSchema,
            annotations,
            { taskSupport: 'forbidden' },
            _meta,
            cb as ToolCallback<AnySchema | undefined>
        );
    }

    /**
     * Registers a prompt with a config object and callback.
     *
     * @example
     * ```ts source="./mcp.examples.ts#McpServer_registerPrompt_basic"
     * server.registerPrompt(
     *     'review-code',
     *     {
     *         title: 'Code Review',
     *         description: 'Review code for best practices',
     *         argsSchema: z.object({ code: z.string() })
     *     },
     *     ({ code }) => ({
     *         messages: [
     *             {
     *                 role: 'user' as const,
     *                 content: {
     *                     type: 'text' as const,
     *                     text: `Please review this code:\n\n${code}`
     *                 }
     *             }
     *         ]
     *     })
     * );
     * ```
     */
    registerPrompt<Args extends AnySchema>(
        name: string,
        config: {
            title?: string;
            description?: string;
            argsSchema?: Args;
        },
        cb: PromptCallback<Args>
    ): RegisteredPrompt {
        if (this._registeredPrompts[name]) {
            throw new Error(`Prompt ${name} is already registered`);
        }

        const { title, description, argsSchema } = config;

        const registeredPrompt = this._createRegisteredPrompt(
            name,
            title,
            description,
            argsSchema,
            cb as PromptCallback<AnySchema | undefined>
        );

        this.setPromptRequestHandlers();
        this.sendPromptListChanged();

        return registeredPrompt;
    }

    /**
     * Checks if the server is connected to a transport.
     * @returns `true` if the server is connected
     */
    isConnected() {
        return this.server.transport !== undefined;
    }

    /**
     * Sends a logging message to the client, if connected.
     * Note: You only need to send the parameters object, not the entire JSON-RPC message.
     * @see {@linkcode LoggingMessageNotification}
     * @param params
     * @param sessionId Optional for stateless transports and backward compatibility.
     *
     * @example
     * ```ts source="./mcp.examples.ts#McpServer_sendLoggingMessage_basic"
     * await server.sendLoggingMessage({
     *     level: 'info',
     *     data: 'Processing complete'
     * });
     * ```
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
}

function createCompletionResult(suggestions: readonly unknown[]): CompleteResult {
    const values = suggestions.map(String).slice(0, 100);
    return {
        completion: {
            values,
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
