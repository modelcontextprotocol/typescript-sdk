import type {
    AnySchema,
    BaseMetadata,
    CallToolRequest,
    CallToolResult,
    CompleteRequestPrompt,
    CompleteRequestResourceTemplate,
    CompleteResult,
    CreateTaskResult,
    CreateTaskServerContext,
    GetPromptResult,
    Implementation,
    ListPromptsResult,
    ListResourcesResult,
    ListToolsResult,
    LoggingMessageNotification,
    Prompt,
    PromptArgument,
    PromptReference,
    ReadResourceResult,
    Resource,
    ResourceTemplateReference,
    Result,
    SchemaOutput,
    ServerContext,
    Tool,
    ToolAnnotations,
    ToolExecution,
    Transport,
    Variables
} from '@modelcontextprotocol/core';
import {
    assertCompleteRequestPrompt,
    assertCompleteRequestResourceTemplate,
    getSchemaDescription,
    getSchemaShape,
    isOptionalSchema,
    parseSchemaAsync,
    ProtocolError,
    ProtocolErrorCode,
    schemaToJson,
    unwrapOptionalSchema,
    UriTemplate,
    validateAndWarnToolName
} from '@modelcontextprotocol/core';

import type { ToolTaskHandler } from '../experimental/tasks/interfaces.js';
import { ExperimentalMcpServerTasks } from '../experimental/tasks/mcpServer.js';
import { getCompleter, isCompletable } from './completable.js';
import type { ServerOptions } from './server.js';
import { Server } from './server.js';

/**
 * High-level MCP server that provides a simpler API for working with resources, tools, and prompts.
 * For advanced usage (like sending notifications or setting custom request handlers), use the underlying
 * {@linkcode Server} instance available via the {@linkcode McpServer.server | server} property.
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
     * Attaches to the given transport, starts it, and starts listening for messages.
     *
     * The `server` object assumes ownership of the {@linkcode Transport}, replacing any callbacks that have already been set, and expects that it is the only user of the {@linkcode Transport} instance going forward.
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
                tools: Object.entries(this._registeredTools)
                    .filter(([, tool]) => tool.enabled)
                    .map(([name, tool]): Tool => {
                        const toolDefinition: Tool = {
                            name,
                            title: tool.title,
                            description: tool.description,
                            inputSchema: tool.inputSchema
                                ? (schemaToJson(tool.inputSchema, { io: 'input' }) as Tool['inputSchema'])
                                : EMPTY_OBJECT_JSON_SCHEMA,
                            annotations: tool.annotations,
                            execution: tool.execution,
                            _meta: tool._meta
                        };

                        if (tool.outputSchema) {
                            toolDefinition.outputSchema = schemaToJson(tool.outputSchema, {
                                io: 'output'
                            }) as Tool['outputSchema'];
                        }

                        return toolDefinition;
                    })
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
            const resources = Object.entries(this._registeredResources)
                .filter(([_, resource]) => resource.enabled)
                .map(([uri, resource]) => ({
                    uri,
                    name: resource.name,
                    ...resource.metadata
                }));

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
            const resourceTemplates = Object.entries(this._registeredResourceTemplates).map(([name, template]) => ({
                name,
                uriTemplate: template.resourceTemplate.uriTemplate.toString(),
                ...template.metadata
            }));

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
                prompts: Object.entries(this._registeredPrompts)
                    .filter(([, prompt]) => prompt.enabled)
                    .map(([name, prompt]): Prompt => {
                        return {
                            name,
                            title: prompt.title,
                            description: prompt.description,
                            arguments: prompt.argsSchema ? promptArgumentsFromSchema(prompt.argsSchema) : undefined
                        };
                    })
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
        const registeredResource: RegisteredResource = {
            name,
            title,
            metadata,
            readCallback,
            enabled: true,
            disable: () => registeredResource.update({ enabled: false }),
            enable: () => registeredResource.update({ enabled: true }),
            remove: () => registeredResource.update({ uri: null }),
            update: updates => {
                if (updates.uri !== undefined && updates.uri !== uri) {
                    delete this._registeredResources[uri];
                    if (updates.uri) this._registeredResources[updates.uri] = registeredResource;
                }
                if (updates.name !== undefined) registeredResource.name = updates.name;
                if (updates.title !== undefined) registeredResource.title = updates.title;
                if (updates.metadata !== undefined) registeredResource.metadata = updates.metadata;
                if (updates.callback !== undefined) registeredResource.readCallback = updates.callback;
                if (updates.enabled !== undefined) registeredResource.enabled = updates.enabled;
                this.sendResourceListChanged();
            }
        };
        this._registeredResources[uri] = registeredResource;
        return registeredResource;
    }

    private _createRegisteredResourceTemplate(
        name: string,
        title: string | undefined,
        template: ResourceTemplate,
        metadata: ResourceMetadata | undefined,
        readCallback: ReadResourceTemplateCallback
    ): RegisteredResourceTemplate {
        const registeredResourceTemplate: RegisteredResourceTemplate = {
            resourceTemplate: template,
            title,
            metadata,
            readCallback,
            enabled: true,
            disable: () => registeredResourceTemplate.update({ enabled: false }),
            enable: () => registeredResourceTemplate.update({ enabled: true }),
            remove: () => registeredResourceTemplate.update({ name: null }),
            update: updates => {
                if (updates.name !== undefined && updates.name !== name) {
                    delete this._registeredResourceTemplates[name];
                    if (updates.name) this._registeredResourceTemplates[updates.name] = registeredResourceTemplate;
                }
                if (updates.title !== undefined) registeredResourceTemplate.title = updates.title;
                if (updates.template !== undefined) registeredResourceTemplate.resourceTemplate = updates.template;
                if (updates.metadata !== undefined) registeredResourceTemplate.metadata = updates.metadata;
                if (updates.callback !== undefined) registeredResourceTemplate.readCallback = updates.callback;
                if (updates.enabled !== undefined) registeredResourceTemplate.enabled = updates.enabled;
                this.sendResourceListChanged();
            }
        };
        this._registeredResourceTemplates[name] = registeredResourceTemplate;

        // If the resource template has any completion callbacks, enable completions capability
        const variableNames = template.uriTemplate.variableNames;
        const hasCompleter = Array.isArray(variableNames) && variableNames.some(v => !!template.completeCallback(v));
        if (hasCompleter) {
            this.setCompletionRequestHandler();
        }

        return registeredResourceTemplate;
    }

    private _createRegisteredPrompt(
        name: string,
        title: string | undefined,
        description: string | undefined,
        argsSchema: AnySchema | undefined,
        callback: PromptCallback<AnySchema | undefined>
    ): RegisteredPrompt {
        // Track current schema and callback for handler regeneration
        let currentArgsSchema = argsSchema;
        let currentCallback = callback;

        const registeredPrompt: RegisteredPrompt = {
            title,
            description,
            argsSchema,
            handler: createPromptHandler(name, argsSchema, callback),
            enabled: true,
            disable: () => registeredPrompt.update({ enabled: false }),
            enable: () => registeredPrompt.update({ enabled: true }),
            remove: () => registeredPrompt.update({ name: null }),
            update: updates => {
                if (updates.name !== undefined && updates.name !== name) {
                    delete this._registeredPrompts[name];
                    if (updates.name) this._registeredPrompts[updates.name] = registeredPrompt;
                }
                if (updates.title !== undefined) registeredPrompt.title = updates.title;
                if (updates.description !== undefined) registeredPrompt.description = updates.description;

                // Track if we need to regenerate the handler
                let needsHandlerRegen = false;
                if (updates.argsSchema !== undefined) {
                    registeredPrompt.argsSchema = updates.argsSchema;
                    currentArgsSchema = updates.argsSchema;
                    needsHandlerRegen = true;
                }
                if (updates.callback !== undefined) {
                    currentCallback = updates.callback as PromptCallback<AnySchema | undefined>;
                    needsHandlerRegen = true;
                }
                if (needsHandlerRegen) {
                    registeredPrompt.handler = createPromptHandler(name, currentArgsSchema, currentCallback);
                }

                if (updates.enabled !== undefined) registeredPrompt.enabled = updates.enabled;
                this.sendPromptListChanged();
            }
        };
        this._registeredPrompts[name] = registeredPrompt;

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

        return registeredPrompt;
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
        // Validate tool name according to SEP specification
        validateAndWarnToolName(name);

        // Track current handler for executor regeneration
        let currentHandler = handler;

        const registeredTool: RegisteredTool = {
            title,
            description,
            inputSchema,
            outputSchema,
            annotations,
            execution,
            _meta,
            handler: handler,
            executor: createToolExecutor(inputSchema, handler),
            enabled: true,
            disable: () => registeredTool.update({ enabled: false }),
            enable: () => registeredTool.update({ enabled: true }),
            remove: () => registeredTool.update({ name: null }),
            update: updates => {
                if (updates.name !== undefined && updates.name !== name) {
                    if (typeof updates.name === 'string') {
                        validateAndWarnToolName(updates.name);
                    }
                    delete this._registeredTools[name];
                    if (updates.name) this._registeredTools[updates.name] = registeredTool;
                }
                if (updates.title !== undefined) registeredTool.title = updates.title;
                if (updates.description !== undefined) registeredTool.description = updates.description;

                // Track if we need to regenerate the executor
                let needsExecutorRegen = false;
                if (updates.paramsSchema !== undefined) {
                    registeredTool.inputSchema = updates.paramsSchema;
                    needsExecutorRegen = true;
                }
                if (updates.callback !== undefined) {
                    registeredTool.handler = updates.callback;
                    currentHandler = updates.callback as AnyToolHandler<AnySchema | undefined>;
                    needsExecutorRegen = true;
                }
                if (needsExecutorRegen) {
                    registeredTool.executor = createToolExecutor(registeredTool.inputSchema, currentHandler);
                }

                if (updates.outputSchema !== undefined) registeredTool.outputSchema = updates.outputSchema;
                if (updates.annotations !== undefined) registeredTool.annotations = updates.annotations;
                if (updates._meta !== undefined) registeredTool._meta = updates._meta;
                if (updates.enabled !== undefined) registeredTool.enabled = updates.enabled;
                this.sendToolListChanged();
            }
        };
        this._registeredTools[name] = registeredTool;

        this.setToolRequestHandlers();
        this.sendToolListChanged();

        return registeredTool;
    }

    /**
     * Registers a tool with a config object and callback.
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
             * A callback to list all resources matching this template. This is required to be specified, even if `undefined`, to avoid accidentally forgetting resource listing.
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

export type BaseToolCallback<ResultT extends Result, Ctx extends ServerContext, Args extends AnySchema | undefined> = Args extends AnySchema
    ? (args: SchemaOutput<Args>, ctx: Ctx) => ResultT | Promise<ResultT>
    : (ctx: Ctx) => ResultT | Promise<ResultT>;

/**
 * Callback for a tool handler registered with {@linkcode McpServer.registerTool}.
 */
export type ToolCallback<Args extends AnySchema | undefined = undefined> = BaseToolCallback<CallToolResult, ServerContext, Args>;

/**
 * Supertype that can handle both regular tools (simple callback) and task-based tools (task handler object).
 */
export type AnyToolHandler<Args extends AnySchema | undefined = undefined> = ToolCallback<Args> | ToolTaskHandler<Args>;

/**
 * Internal executor type that encapsulates handler invocation with proper types.
 */
type ToolExecutor = (args: unknown, ctx: ServerContext) => Promise<CallToolResult | CreateTaskResult>;

export type RegisteredTool = {
    title?: string;
    description?: string;
    inputSchema?: AnySchema;
    outputSchema?: AnySchema;
    annotations?: ToolAnnotations;
    execution?: ToolExecution;
    _meta?: Record<string, unknown>;
    handler: AnyToolHandler<AnySchema | undefined>;
    /** @internal */
    executor: ToolExecutor;
    enabled: boolean;
    enable(): void;
    disable(): void;
    update(updates: {
        name?: string | null;
        title?: string;
        description?: string;
        paramsSchema?: AnySchema;
        outputSchema?: AnySchema;
        annotations?: ToolAnnotations;
        _meta?: Record<string, unknown>;
        callback?: ToolCallback<AnySchema>;
        enabled?: boolean;
    }): void;
    remove(): void;
};

/**
 * Creates an executor that invokes the handler with the appropriate arguments.
 * When `inputSchema` is defined, the handler is called with `(args, ctx)`.
 * When `inputSchema` is undefined, the handler is called with just `(ctx)`.
 */
function createToolExecutor(inputSchema: AnySchema | undefined, handler: AnyToolHandler<AnySchema | undefined>): ToolExecutor {
    const isTaskHandler = 'createTask' in handler;

    if (isTaskHandler) {
        const taskHandler = handler as TaskHandlerInternal;
        return async (args, ctx) => {
            if (!ctx.task?.store) {
                throw new Error('No task store provided.');
            }
            const taskCtx: CreateTaskServerContext = { ...ctx, task: { store: ctx.task.store, requestedTtl: ctx.task?.requestedTtl } };
            if (inputSchema) {
                return taskHandler.createTask(args, taskCtx);
            }
            // When no inputSchema, call with just ctx (the handler expects (ctx) signature)
            return (taskHandler.createTask as (ctx: CreateTaskServerContext) => CreateTaskResult | Promise<CreateTaskResult>)(taskCtx);
        };
    }

    if (inputSchema) {
        const callback = handler as ToolCallbackInternal;
        return async (args, ctx) => callback(args, ctx);
    }

    // When no inputSchema, call with just ctx (the handler expects (ctx) signature)
    const callback = handler as (ctx: ServerContext) => CallToolResult | Promise<CallToolResult>;
    return async (_args, ctx) => callback(ctx);
}

const EMPTY_OBJECT_JSON_SCHEMA = {
    type: 'object' as const,
    properties: {}
};

/**
 * Additional, optional information for annotating a resource.
 */
export type ResourceMetadata = Omit<Resource, 'uri' | 'name'>;

/**
 * Callback to list all resources matching a given template.
 */
export type ListResourcesCallback = (ctx: ServerContext) => ListResourcesResult | Promise<ListResourcesResult>;

/**
 * Callback to read a resource at a given URI.
 */
export type ReadResourceCallback = (uri: URL, ctx: ServerContext) => ReadResourceResult | Promise<ReadResourceResult>;

export type RegisteredResource = {
    name: string;
    title?: string;
    metadata?: ResourceMetadata;
    readCallback: ReadResourceCallback;
    enabled: boolean;
    enable(): void;
    disable(): void;
    update(updates: {
        name?: string;
        title?: string;
        uri?: string | null;
        metadata?: ResourceMetadata;
        callback?: ReadResourceCallback;
        enabled?: boolean;
    }): void;
    remove(): void;
};

/**
 * Callback to read a resource at a given URI, following a filled-in URI template.
 */
export type ReadResourceTemplateCallback = (
    uri: URL,
    variables: Variables,
    ctx: ServerContext
) => ReadResourceResult | Promise<ReadResourceResult>;

export type RegisteredResourceTemplate = {
    resourceTemplate: ResourceTemplate;
    title?: string;
    metadata?: ResourceMetadata;
    readCallback: ReadResourceTemplateCallback;
    enabled: boolean;
    enable(): void;
    disable(): void;
    update(updates: {
        name?: string | null;
        title?: string;
        template?: ResourceTemplate;
        metadata?: ResourceMetadata;
        callback?: ReadResourceTemplateCallback;
        enabled?: boolean;
    }): void;
    remove(): void;
};

export type PromptCallback<Args extends AnySchema | undefined = undefined> = Args extends AnySchema
    ? (args: SchemaOutput<Args>, ctx: ServerContext) => GetPromptResult | Promise<GetPromptResult>
    : (ctx: ServerContext) => GetPromptResult | Promise<GetPromptResult>;

/**
 * Internal handler type that encapsulates parsing and callback invocation.
 * This allows type-safe handling without runtime type assertions.
 */
type PromptHandler = (args: Record<string, unknown> | undefined, ctx: ServerContext) => Promise<GetPromptResult>;

type ToolCallbackInternal = (args: unknown, ctx: ServerContext) => CallToolResult | Promise<CallToolResult>;

type TaskHandlerInternal = {
    createTask: (args: unknown, ctx: CreateTaskServerContext) => CreateTaskResult | Promise<CreateTaskResult>;
};

export type RegisteredPrompt = {
    title?: string;
    description?: string;
    argsSchema?: AnySchema;
    /** @internal */
    handler: PromptHandler;
    enabled: boolean;
    enable(): void;
    disable(): void;
    update<Args extends AnySchema>(updates: {
        name?: string | null;
        title?: string;
        description?: string;
        argsSchema?: Args;
        callback?: PromptCallback<Args>;
        enabled?: boolean;
    }): void;
    remove(): void;
};

/**
 * Creates a type-safe prompt handler that captures the schema and callback in a closure.
 * This eliminates the need for type assertions at the call site.
 */
function createPromptHandler(
    name: string,
    argsSchema: AnySchema | undefined,
    callback: PromptCallback<AnySchema | undefined>
): PromptHandler {
    if (argsSchema) {
        const typedCallback = callback as (args: SchemaOutput<AnySchema>, ctx: ServerContext) => GetPromptResult | Promise<GetPromptResult>;

        return async (args, ctx) => {
            const parseResult = await parseSchemaAsync(argsSchema, args);
            if (!parseResult.success) {
                const errorMessage = parseResult.error.issues.map((i: { message: string }) => i.message).join(', ');
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid arguments for prompt ${name}: ${errorMessage}`);
            }
            return typedCallback(parseResult.data as SchemaOutput<AnySchema>, ctx);
        };
    } else {
        const typedCallback = callback as (ctx: ServerContext) => GetPromptResult | Promise<GetPromptResult>;

        return async (_args, ctx) => {
            return typedCallback(ctx);
        };
    }
}

function promptArgumentsFromSchema(schema: AnySchema): PromptArgument[] {
    const shape = getSchemaShape(schema);
    if (!shape) return [];
    return Object.entries(shape).map(([name, field]): PromptArgument => {
        return {
            name,
            description: getSchemaDescription(field),
            required: !isOptionalSchema(field)
        };
    });
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
