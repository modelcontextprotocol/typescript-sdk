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
    RequestHandlerExtra,
    Resource,
    ResourceTemplateReference,
    Result,
    SchemaOutput,
    ServerNotification,
    ServerRequest,
    ShapeOutput,
    Tool,
    ToolAnnotations,
    ToolExecution,
    Transport,
    Variables,
    ZodRawShapeCompat
} from '@modelcontextprotocol/core';
import {
    assertCompleteRequestPrompt,
    assertCompleteRequestResourceTemplate,
    getObjectShape,
    getParseErrorMessage,
    getSchemaDescription,
    isSchemaOptional,
    normalizeObjectSchema,
    objectFromShape,
    ProtocolError,
    ProtocolErrorCode,
    safeParseAsync,
    toJsonSchemaCompat,
    UriTemplate,
    validateAndWarnToolName
} from '@modelcontextprotocol/core';
import { ZodOptional } from 'zod';

import type { ToolTaskHandler } from '../experimental/tasks/interfaces.js';
import { ExperimentalMcpServerTasks } from '../experimental/tasks/mcpServer.js';
import { getCompleter, isCompletable } from './completable.js';
import type { ServerOptions } from './server.js';
import { Server } from './server.js';

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

        this.server.assertCanSetRequestHandler('tools/list');
        this.server.assertCanSetRequestHandler('tools/call');

        this.server.registerCapabilities({
            tools: {
                listChanged: true
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
                            inputSchema: (() => {
                                const obj = normalizeObjectSchema(tool.inputSchema);
                                return obj
                                    ? (toJsonSchemaCompat(obj, {
                                          strictUnions: true,
                                          pipeStrategy: 'input'
                                      }) as Tool['inputSchema'])
                                    : EMPTY_OBJECT_JSON_SCHEMA;
                            })(),
                            annotations: tool.annotations,
                            execution: tool.execution,
                            _meta: tool._meta
                        };

                        if (tool.outputSchema) {
                            const obj = normalizeObjectSchema(tool.outputSchema);
                            if (obj) {
                                toolDefinition.outputSchema = toJsonSchemaCompat(obj, {
                                    strictUnions: true,
                                    pipeStrategy: 'output'
                                }) as Tool['outputSchema'];
                            }
                        }

                        return toolDefinition;
                    })
            })
        );

        this.server.setRequestHandler('tools/call', async (request, extra): Promise<CallToolResult | CreateTaskResult> => {
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
                const isTaskHandler = 'createTask' in (tool.handler as AnyToolHandler<ZodRawShapeCompat>);

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
                    return await this.handleAutomaticTaskPolling(tool, request, extra);
                }

                // Normal execution path
                const args = await this.validateToolInput(tool, request.params.arguments, request.params.name);
                const result = await this.executeToolHandler(tool, args, extra);

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

        // Try to normalize to object schema first (for raw shapes and object schemas)
        // If that fails, use the schema directly (for union/intersection/etc)
        const inputObj = normalizeObjectSchema(tool.inputSchema);
        const schemaToParse = inputObj ?? (tool.inputSchema as AnySchema);
        const parseResult = await safeParseAsync(schemaToParse, args ?? {});
        if (!parseResult.success) {
            const error = 'error' in parseResult ? parseResult.error : 'Unknown error';
            const errorMessage = getParseErrorMessage(error);
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
        const outputObj = normalizeObjectSchema(tool.outputSchema) as AnyObjectSchema;
        const parseResult = await safeParseAsync(outputObj, result.structuredContent);
        if (!parseResult.success) {
            const error = 'error' in parseResult ? parseResult.error : 'Unknown error';
            const errorMessage = getParseErrorMessage(error);
            throw new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                `Output validation error: Invalid structured content for tool ${toolName}: ${errorMessage}`
            );
        }
    }

    /**
     * Executes a tool handler (either regular or task-based).
     */
    private async executeToolHandler(
        tool: RegisteredTool,
        args: unknown,
        extra: RequestHandlerExtra<ServerRequest, ServerNotification>
    ): Promise<CallToolResult | CreateTaskResult> {
        const handler = tool.handler as AnyToolHandler<ZodRawShapeCompat | undefined>;
        const isTaskHandler = 'createTask' in handler;

        if (isTaskHandler) {
            if (!extra.taskStore) {
                throw new Error('No task store provided.');
            }
            const taskExtra = { ...extra, taskStore: extra.taskStore };

            if (tool.inputSchema) {
                const typedHandler = handler as ToolTaskHandler<ZodRawShapeCompat>;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return await Promise.resolve(typedHandler.createTask(args as any, taskExtra));
            } else {
                const typedHandler = handler as ToolTaskHandler<undefined>;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return await Promise.resolve((typedHandler.createTask as any)(taskExtra));
            }
        }

        if (tool.inputSchema) {
            const typedHandler = handler as ToolCallback<ZodRawShapeCompat>;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return await Promise.resolve(typedHandler(args as any, extra));
        } else {
            const typedHandler = handler as ToolCallback<undefined>;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return await Promise.resolve((typedHandler as any)(extra));
        }
    }

    /**
     * Handles automatic task polling for tools with taskSupport 'optional'.
     */
    private async handleAutomaticTaskPolling<RequestT extends CallToolRequest>(
        tool: RegisteredTool,
        request: RequestT,
        extra: RequestHandlerExtra<ServerRequest, ServerNotification>
    ): Promise<CallToolResult> {
        if (!extra.taskStore) {
            throw new Error('No task store provided for task-capable tool.');
        }

        // Validate input and create task
        const args = await this.validateToolInput(tool, request.params.arguments, request.params.name);
        const handler = tool.handler as ToolTaskHandler<ZodRawShapeCompat | undefined>;
        const taskExtra = { ...extra, taskStore: extra.taskStore };

        const createTaskResult: CreateTaskResult = args // undefined only if tool.inputSchema is undefined
            ? await Promise.resolve((handler as ToolTaskHandler<ZodRawShapeCompat>).createTask(args, taskExtra))
            : // eslint-disable-next-line @typescript-eslint/no-explicit-any
              await Promise.resolve(((handler as ToolTaskHandler<undefined>).createTask as any)(taskExtra));

        // Poll until completion
        const taskId = createTaskResult.task.taskId;
        let task = createTaskResult.task;
        const pollInterval = task.pollInterval ?? 5000;

        while (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled') {
            await new Promise(resolve => setTimeout(resolve, pollInterval));
            const updatedTask = await extra.taskStore.getTask(taskId);
            if (!updatedTask) {
                throw new ProtocolError(ProtocolErrorCode.InternalError, `Task ${taskId} not found during polling`);
            }
            task = updatedTask;
        }

        // Return the final result
        return (await extra.taskStore.getTaskResult(taskId)) as CallToolResult;
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
                listChanged: true
            }
        });

        this.server.setRequestHandler('resources/list', async (_request, extra) => {
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

                const result = await template.resourceTemplate.listCallback(extra);
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

        this.server.setRequestHandler('resources/read', async (request, extra) => {
            const uri = new URL(request.params.uri);

            // First check for exact resource match
            const resource = this._registeredResources[uri.toString()];
            if (resource) {
                if (!resource.enabled) {
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource ${uri} disabled`);
                }
                return resource.readCallback(uri, extra);
            }

            // Then check templates
            for (const template of Object.values(this._registeredResourceTemplates)) {
                const variables = template.resourceTemplate.uriTemplate.match(uri.toString());
                if (variables) {
                    return template.readCallback(uri, variables, extra);
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
                listChanged: true
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

        this.server.setRequestHandler('prompts/get', async (request, extra): Promise<GetPromptResult> => {
            const prompt = this._registeredPrompts[request.params.name];
            if (!prompt) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Prompt ${request.params.name} not found`);
            }

            if (!prompt.enabled) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Prompt ${request.params.name} disabled`);
            }

            if (prompt.argsSchema) {
                const argsObj = normalizeObjectSchema(prompt.argsSchema) as AnyObjectSchema;
                const parseResult = await safeParseAsync(argsObj, request.params.arguments);
                if (!parseResult.success) {
                    const error = 'error' in parseResult ? parseResult.error : 'Unknown error';
                    const errorMessage = getParseErrorMessage(error);
                    throw new ProtocolError(
                        ProtocolErrorCode.InvalidParams,
                        `Invalid arguments for prompt ${request.params.name}: ${errorMessage}`
                    );
                }

                const args = parseResult.data;
                const cb = prompt.callback as PromptCallback<PromptArgsRawShape>;
                return await Promise.resolve(cb(args, extra));
            } else {
                const cb = prompt.callback as PromptCallback<undefined>;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return await Promise.resolve((cb as any)(extra));
            }
        });

        this._promptHandlersInitialized = true;
    }

    /**
     * Registers a resource with a config object and callback.
     * For static resources, use a URI string. For dynamic resources, use a ResourceTemplate.
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
        argsSchema: PromptArgsRawShape | undefined,
        callback: PromptCallback<PromptArgsRawShape | undefined>
    ): RegisteredPrompt {
        const registeredPrompt: RegisteredPrompt = {
            title,
            description,
            argsSchema: argsSchema === undefined ? undefined : objectFromShape(argsSchema),
            callback,
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
                if (updates.argsSchema !== undefined) registeredPrompt.argsSchema = objectFromShape(updates.argsSchema);
                if (updates.callback !== undefined) registeredPrompt.callback = updates.callback;
                if (updates.enabled !== undefined) registeredPrompt.enabled = updates.enabled;
                this.sendPromptListChanged();
            }
        };
        this._registeredPrompts[name] = registeredPrompt;

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

    private _createRegisteredTool(
        name: string,
        title: string | undefined,
        description: string | undefined,
        inputSchema: ZodRawShapeCompat | AnySchema | undefined,
        outputSchema: ZodRawShapeCompat | AnySchema | undefined,
        annotations: ToolAnnotations | undefined,
        execution: ToolExecution | undefined,
        _meta: Record<string, unknown> | undefined,
        handler: AnyToolHandler<ZodRawShapeCompat | undefined>
    ): RegisteredTool {
        // Validate tool name according to SEP specification
        validateAndWarnToolName(name);

        const registeredTool: RegisteredTool = {
            title,
            description,
            inputSchema: getZodSchemaObject(inputSchema),
            outputSchema: getZodSchemaObject(outputSchema),
            annotations,
            execution,
            _meta,
            handler: handler,
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
                if (updates.paramsSchema !== undefined) registeredTool.inputSchema = objectFromShape(updates.paramsSchema);
                if (updates.outputSchema !== undefined) registeredTool.outputSchema = objectFromShape(updates.outputSchema);
                if (updates.callback !== undefined) registeredTool.handler = updates.callback;
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
    registerTool<OutputArgs extends ZodRawShapeCompat | AnySchema, InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined>(
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
            cb as ToolCallback<ZodRawShapeCompat | undefined>
        );
    }

    /**
     * Registers a prompt with a config object and callback.
     */
    registerPrompt<Args extends PromptArgsRawShape>(
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
            cb as PromptCallback<PromptArgsRawShape | undefined>
        );

        this.setPromptRequestHandlers();
        this.sendPromptListChanged();

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
    Extra extends RequestHandlerExtra<ServerRequest, ServerNotification>,
    Args extends undefined | ZodRawShapeCompat | AnySchema
> = Args extends ZodRawShapeCompat
    ? (args: ShapeOutput<Args>, extra: Extra) => SendResultT | Promise<SendResultT>
    : Args extends AnySchema
      ? (args: SchemaOutput<Args>, extra: Extra) => SendResultT | Promise<SendResultT>
      : (extra: Extra) => SendResultT | Promise<SendResultT>;

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
    RequestHandlerExtra<ServerRequest, ServerNotification>,
    Args
>;

/**
 * Supertype that can handle both regular tools (simple callback) and task-based tools (task handler object).
 */
export type AnyToolHandler<Args extends undefined | ZodRawShapeCompat | AnySchema = undefined> = ToolCallback<Args> | ToolTaskHandler<Args>;

export type RegisteredTool = {
    title?: string;
    description?: string;
    inputSchema?: AnySchema;
    outputSchema?: AnySchema;
    annotations?: ToolAnnotations;
    execution?: ToolExecution;
    _meta?: Record<string, unknown>;
    handler: AnyToolHandler<undefined | ZodRawShapeCompat>;
    enabled: boolean;
    enable(): void;
    disable(): void;
    update<InputArgs extends ZodRawShapeCompat, OutputArgs extends ZodRawShapeCompat>(updates: {
        name?: string | null;
        title?: string;
        description?: string;
        paramsSchema?: InputArgs;
        outputSchema?: OutputArgs;
        annotations?: ToolAnnotations;
        _meta?: Record<string, unknown>;
        callback?: ToolCallback<InputArgs>;
        enabled?: boolean;
    }): void;
    remove(): void;
};

const EMPTY_OBJECT_JSON_SCHEMA = {
    type: 'object' as const,
    properties: {}
};

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
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>
) => ListResourcesResult | Promise<ListResourcesResult>;

/**
 * Callback to read a resource at a given URI.
 */
export type ReadResourceCallback = (
    uri: URL,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>
) => ReadResourceResult | Promise<ReadResourceResult>;

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
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>
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

type PromptArgsRawShape = ZodRawShapeCompat;

export type PromptCallback<Args extends undefined | PromptArgsRawShape = undefined> = Args extends PromptArgsRawShape
    ? (args: ShapeOutput<Args>, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => GetPromptResult | Promise<GetPromptResult>
    : (extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => GetPromptResult | Promise<GetPromptResult>;

export type RegisteredPrompt = {
    title?: string;
    description?: string;
    argsSchema?: AnyObjectSchema;
    callback: PromptCallback<undefined | PromptArgsRawShape>;
    enabled: boolean;
    enable(): void;
    disable(): void;
    update<Args extends PromptArgsRawShape>(updates: {
        name?: string | null;
        title?: string;
        description?: string;
        argsSchema?: Args;
        callback?: PromptCallback<Args>;
        enabled?: boolean;
    }): void;
    remove(): void;
};

function promptArgumentsFromSchema(schema: AnyObjectSchema): PromptArgument[] {
    const shape = getObjectShape(schema);
    if (!shape) return [];
    return Object.entries(shape).map(([name, field]): PromptArgument => {
        // Get description - works for both v3 and v4
        const description = getSchemaDescription(field);
        // Check if optional - works for both v3 and v4
        const isOptional = isSchemaOptional(field);
        return {
            name,
            description,
            required: !isOptional
        };
    });
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
