import type {
    BaseMetadata,
    CallToolRequest,
    CallToolResult,
    CompleteRequestPrompt,
    CompleteRequestResourceTemplate,
    CompleteResult,
    CreateTaskResult,
    CreateTaskServerContext,
    GetPromptResult,
    ListPromptsResult,
    ListToolsResult,
    Prompt,
    PromptReference,
    ReadResourceResult,
    RequestMethod,
    RequestTypeMap,
    Resource,
    ResourceTemplateReference,
    Result,
    ResultTypeMap,
    ServerCapabilities,
    ServerContext,
    StandardSchemaWithJSON,
    Tool,
    ToolAnnotations,
    ToolExecution,
    Variables
} from '@modelcontextprotocol/core';
import {
    assertCompleteRequestPrompt,
    assertCompleteRequestResourceTemplate,
    promptArgumentsFromStandardSchema,
    ProtocolError,
    ProtocolErrorCode,
    standardSchemaToJsonSchema,
    validateAndWarnToolName,
    validateStandardSchema
} from '@modelcontextprotocol/core';

import type { ToolTaskHandler } from '../experimental/tasks/interfaces.js';
import { getCompleter, isCompletable } from './completable.js';
import type { ResourceTemplate } from './resourceTemplate.js';
import type { ZodRawShapeCompat } from './serverLegacy.js';
import { coerceSchema } from './serverLegacy.js';

/**
 * Minimal surface a {@linkcode ServerRegistries} instance needs from its owning server.
 * {@linkcode McpServer} satisfies this directly.
 */
export interface RegistriesHost {
    setRequestHandler<M extends RequestMethod>(
        method: M,
        handler: (request: RequestTypeMap[M], ctx: ServerContext) => ResultTypeMap[M] | Promise<ResultTypeMap[M]>
    ): void;
    assertCanSetRequestHandler(method: string): void;
    registerCapabilities(capabilities: ServerCapabilities): void;
    getCapabilities(): ServerCapabilities;
    sendToolListChanged(): Promise<void>;
    sendResourceListChanged(): Promise<void>;
    sendPromptListChanged(): Promise<void>;
    /**
     * Lazy installers, called on first registerTool/Resource/Prompt. Defined on the host so
     * subclasses can override the install (v1 compat for code that monkey-patches `setToolRequestHandlers`).
     * Default impl on McpServer delegates back to {@link ServerRegistries}.
     */
    setToolRequestHandlers(): void;
    setResourceRequestHandlers(): void;
    setPromptRequestHandlers(): void;
    setCompletionRequestHandler(): void;
}

/**
 * In-memory tool/resource/prompt registries plus the lazy `tools/*`, `resources/*`,
 * `prompts/*`, and `completion/*` request-handler installers.
 *
 * Composed by {@linkcode McpServer}. One instance per server.
 */
export class ServerRegistries {
    readonly registeredResources: { [uri: string]: RegisteredResource } = {};
    readonly registeredResourceTemplates: { [name: string]: RegisteredResourceTemplate } = {};
    readonly registeredTools: { [name: string]: RegisteredTool } = {};
    readonly registeredPrompts: { [name: string]: RegisteredPrompt } = {};

    private _toolHandlersInitialized = false;
    private _completionHandlerInitialized = false;
    private _resourceHandlersInitialized = false;
    private _promptHandlersInitialized = false;

    constructor(private readonly host: RegistriesHost) {}

    // ───────────────────────────────────────────────────────────────────────
    // Tools
    // ───────────────────────────────────────────────────────────────────────

    /** @internal v1-compat: kept callable so subclassers can invoke the default after overriding the host hook. */
    setToolRequestHandlers(): void {
        if (this._toolHandlersInitialized) return;
        const h = this.host;
        h.assertCanSetRequestHandler('tools/list');
        h.assertCanSetRequestHandler('tools/call');
        h.registerCapabilities({ tools: { listChanged: h.getCapabilities().tools?.listChanged ?? true } });

        h.setRequestHandler(
            'tools/list',
            (): ListToolsResult => ({
                tools: Object.entries(this.registeredTools)
                    .filter(([, tool]) => tool.enabled)
                    .map(([name, tool]): Tool => {
                        const def: Tool = {
                            name,
                            title: tool.title,
                            description: tool.description,
                            inputSchema: tool.inputSchema
                                ? (standardSchemaToJsonSchema(tool.inputSchema, 'input') as Tool['inputSchema'])
                                : EMPTY_OBJECT_JSON_SCHEMA,
                            annotations: tool.annotations,
                            execution: tool.execution,
                            _meta: tool._meta
                        };
                        if (tool.outputSchema) {
                            def.outputSchema = standardSchemaToJsonSchema(tool.outputSchema, 'output') as Tool['outputSchema'];
                        }
                        return def;
                    })
            })
        );

        h.setRequestHandler('tools/call', async (request, ctx): Promise<CallToolResult | CreateTaskResult> => {
            const tool = this.registeredTools[request.params.name];
            if (!tool) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
            }
            if (!tool.enabled) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${request.params.name} disabled`);
            }
            try {
                const isTaskRequest = !!request.params.task;
                const taskSupport = tool.execution?.taskSupport;
                const isTaskHandler = 'createTask' in (tool.handler as AnyToolHandler<StandardSchemaWithJSON>);
                if ((taskSupport === 'required' || taskSupport === 'optional') && !isTaskHandler) {
                    throw new ProtocolError(
                        ProtocolErrorCode.InternalError,
                        `Tool ${request.params.name} has taskSupport '${taskSupport}' but was not registered with registerToolTask`
                    );
                }
                if (taskSupport === 'required' && !isTaskRequest) {
                    throw new ProtocolError(
                        ProtocolErrorCode.MethodNotFound,
                        `Tool ${request.params.name} requires task augmentation (taskSupport: 'required')`
                    );
                }
                if (taskSupport === 'optional' && !isTaskRequest && isTaskHandler) {
                    return await this.handleAutomaticTaskPolling(tool, request, ctx);
                }
                const args = await this.validateToolInput(tool, request.params.arguments, request.params.name);
                const result = await tool.executor(args, ctx);
                if (isTaskRequest) return result;
                await this.validateToolOutput(tool, result, request.params.name);
                return result;
            } catch (error) {
                if (error instanceof ProtocolError && error.code === ProtocolErrorCode.UrlElicitationRequired) {
                    throw error;
                }
                return createToolError(error instanceof Error ? error.message : String(error));
            }
        });

        this._toolHandlersInitialized = true;
    }

    /** @internal v1-compat */
    async validateToolInput<
        ToolType extends RegisteredTool,
        Args extends ToolType['inputSchema'] extends infer InputSchema
            ? InputSchema extends StandardSchemaWithJSON
                ? StandardSchemaWithJSON.InferOutput<InputSchema>
                : undefined
            : undefined
    >(tool: ToolType, args: Args, toolName: string): Promise<Args> {
        if (!tool.inputSchema) return undefined as Args;
        const parsed = await validateStandardSchema(tool.inputSchema, args ?? {});
        if (!parsed.success) {
            throw new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                `Input validation error: Invalid arguments for tool ${toolName}: ${parsed.error}`
            );
        }
        return parsed.data as unknown as Args;
    }

    /** @internal v1-compat */
    async validateToolOutput(tool: RegisteredTool, result: CallToolResult | CreateTaskResult, toolName: string): Promise<void> {
        if (!tool.outputSchema) return;
        if (!('content' in result)) return;
        if (result.isError) return;
        if (!result.structuredContent) {
            throw new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                `Output validation error: Tool ${toolName} has an output schema but no structured content was provided`
            );
        }
        const parsed = await validateStandardSchema(tool.outputSchema, result.structuredContent);
        if (!parsed.success) {
            throw new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                `Output validation error: Invalid structured content for tool ${toolName}: ${parsed.error}`
            );
        }
    }

    /** @internal v1-compat */
    async handleAutomaticTaskPolling<RequestT extends CallToolRequest>(
        tool: RegisteredTool,
        request: RequestT,
        ctx: ServerContext
    ): Promise<CallToolResult> {
        if (!ctx.task?.store) {
            throw new Error('No task store provided for task-capable tool.');
        }
        const args = await this.validateToolInput(tool, request.params.arguments, request.params.name);
        const createTaskResult = (await tool.executor(args, ctx)) as CreateTaskResult;
        const taskId = createTaskResult.task.taskId;
        let task = createTaskResult.task;
        const pollInterval = task.pollInterval ?? 5000;
        while (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled') {
            await new Promise(resolve => setTimeout(resolve, pollInterval));
            const updated = await ctx.task.store.getTask(taskId);
            if (!updated) {
                throw new ProtocolError(ProtocolErrorCode.InternalError, `Task ${taskId} not found during polling`);
            }
            task = updated;
        }
        return (await ctx.task.store.getTaskResult(taskId)) as CallToolResult;
    }

    // ───────────────────────────────────────────────────────────────────────
    // Completion
    // ───────────────────────────────────────────────────────────────────────

    /** @internal v1-compat */
    setCompletionRequestHandler(): void {
        if (this._completionHandlerInitialized) return;
        const h = this.host;
        h.assertCanSetRequestHandler('completion/complete');
        h.registerCapabilities({ completions: {} });
        h.setRequestHandler('completion/complete', async (request): Promise<CompleteResult> => {
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
        const prompt = this.registeredPrompts[ref.name];
        if (!prompt) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Prompt ${ref.name} not found`);
        if (!prompt.enabled) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Prompt ${ref.name} disabled`);
        if (!prompt.argsSchema) return EMPTY_COMPLETION_RESULT;
        const promptShape = getSchemaShape(prompt.argsSchema);
        const field = unwrapOptionalSchema(promptShape?.[request.params.argument.name]);
        if (!isCompletable(field)) return EMPTY_COMPLETION_RESULT;
        const completer = getCompleter(field);
        if (!completer) return EMPTY_COMPLETION_RESULT;
        const suggestions = await completer(request.params.argument.value, request.params.context);
        return createCompletionResult(suggestions);
    }

    private async handleResourceCompletion(
        request: CompleteRequestResourceTemplate,
        ref: ResourceTemplateReference
    ): Promise<CompleteResult> {
        const template = Object.values(this.registeredResourceTemplates).find(t => t.resourceTemplate.uriTemplate.toString() === ref.uri);
        if (!template) {
            if (this.registeredResources[ref.uri]) return EMPTY_COMPLETION_RESULT;
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource template ${request.params.ref.uri} not found`);
        }
        const completer = template.resourceTemplate.completeCallback(request.params.argument.name);
        if (!completer) return EMPTY_COMPLETION_RESULT;
        const suggestions = await completer(request.params.argument.value, request.params.context);
        return createCompletionResult(suggestions);
    }

    // ───────────────────────────────────────────────────────────────────────
    // Resources
    // ───────────────────────────────────────────────────────────────────────

    /** @internal v1-compat */
    setResourceRequestHandlers(): void {
        if (this._resourceHandlersInitialized) return;
        const h = this.host;
        h.assertCanSetRequestHandler('resources/list');
        h.assertCanSetRequestHandler('resources/templates/list');
        h.assertCanSetRequestHandler('resources/read');
        h.registerCapabilities({ resources: { listChanged: h.getCapabilities().resources?.listChanged ?? true } });

        h.setRequestHandler('resources/list', async (_request, ctx) => {
            const resources = Object.entries(this.registeredResources)
                .filter(([_, r]) => r.enabled)
                .map(([uri, r]) => ({ uri, name: r.name, ...r.metadata }));
            const templateResources: Resource[] = [];
            for (const template of Object.values(this.registeredResourceTemplates)) {
                if (!template.resourceTemplate.listCallback) continue;
                const result = await template.resourceTemplate.listCallback(ctx);
                for (const resource of result.resources) {
                    templateResources.push({ ...template.metadata, ...resource });
                }
            }
            return { resources: [...resources, ...templateResources] };
        });

        h.setRequestHandler('resources/templates/list', async () => {
            const resourceTemplates = Object.entries(this.registeredResourceTemplates).map(([name, t]) => ({
                name,
                uriTemplate: t.resourceTemplate.uriTemplate.toString(),
                ...t.metadata
            }));
            return { resourceTemplates };
        });

        h.setRequestHandler('resources/read', async (request, ctx) => {
            const uri = new URL(request.params.uri);
            const resource = this.registeredResources[uri.toString()];
            if (resource) {
                if (!resource.enabled) {
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource ${uri} disabled`);
                }
                return resource.readCallback(uri, ctx);
            }
            for (const template of Object.values(this.registeredResourceTemplates)) {
                const variables = template.resourceTemplate.uriTemplate.match(uri.toString());
                if (variables) return template.readCallback(uri, variables, ctx);
            }
            throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, `Resource ${uri} not found`);
        });

        this._resourceHandlersInitialized = true;
    }

    // ───────────────────────────────────────────────────────────────────────
    // Prompts
    // ───────────────────────────────────────────────────────────────────────

    /** @internal v1-compat */
    setPromptRequestHandlers(): void {
        if (this._promptHandlersInitialized) return;
        const h = this.host;
        h.assertCanSetRequestHandler('prompts/list');
        h.assertCanSetRequestHandler('prompts/get');
        h.registerCapabilities({ prompts: { listChanged: h.getCapabilities().prompts?.listChanged ?? true } });

        h.setRequestHandler(
            'prompts/list',
            (): ListPromptsResult => ({
                prompts: Object.entries(this.registeredPrompts)
                    .filter(([, p]) => p.enabled)
                    .map(
                        ([name, p]): Prompt => ({
                            name,
                            title: p.title,
                            description: p.description,
                            arguments: p.argsSchema ? promptArgumentsFromStandardSchema(p.argsSchema) : undefined,
                            _meta: p._meta
                        })
                    )
            })
        );

        h.setRequestHandler('prompts/get', async (request, ctx): Promise<GetPromptResult> => {
            const prompt = this.registeredPrompts[request.params.name];
            if (!prompt) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Prompt ${request.params.name} not found`);
            if (!prompt.enabled) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Prompt ${request.params.name} disabled`);
            return prompt.handler(request.params.arguments, ctx);
        });

        this._promptHandlersInitialized = true;
    }

    // ───────────────────────────────────────────────────────────────────────
    // Public registration entry points
    // ───────────────────────────────────────────────────────────────────────

    /**
     * Registers a resource with a config object and callback.
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
            if (this.registeredResources[uriOrTemplate]) throw new Error(`Resource ${uriOrTemplate} is already registered`);
            const r = this.createRegisteredResource(
                name,
                (config as BaseMetadata).title,
                uriOrTemplate,
                config,
                readCallback as ReadResourceCallback
            );
            this.host.setResourceRequestHandlers();
            this.host.sendResourceListChanged();
            return r;
        } else {
            if (this.registeredResourceTemplates[name]) throw new Error(`Resource template ${name} is already registered`);
            const r = this.createRegisteredResourceTemplate(
                name,
                (config as BaseMetadata).title,
                uriOrTemplate,
                config,
                readCallback as ReadResourceTemplateCallback
            );
            this.host.setResourceRequestHandlers();
            this.host.sendResourceListChanged();
            return r;
        }
    }

    /**
     * Registers a tool with a config object and callback.
     */
    registerTool<OutputArgs extends StandardSchemaWithJSON, InputArgs extends StandardSchemaWithJSON | undefined = undefined>(
        name: string,
        config: {
            title?: string;
            description?: string;
            inputSchema?: InputArgs | ZodRawShapeCompat;
            outputSchema?: OutputArgs | ZodRawShapeCompat;
            annotations?: ToolAnnotations;
            _meta?: Record<string, unknown>;
        },
        cb: ToolCallback<InputArgs>
    ): RegisteredTool {
        if (this.registeredTools[name]) throw new Error(`Tool ${name} is already registered`);
        const { title, description, inputSchema, outputSchema, annotations, _meta } = config;
        return this.createRegisteredTool(
            name,
            title,
            description,
            coerceSchema(inputSchema),
            coerceSchema(outputSchema),
            annotations,
            { taskSupport: 'forbidden' },
            _meta,
            cb as ToolCallback<StandardSchemaWithJSON | undefined>
        );
    }

    /**
     * Registers a prompt with a config object and callback.
     */
    registerPrompt<Args extends StandardSchemaWithJSON>(
        name: string,
        config: { title?: string; description?: string; argsSchema?: Args | ZodRawShapeCompat; _meta?: Record<string, unknown> },
        cb: PromptCallback<Args>
    ): RegisteredPrompt {
        if (this.registeredPrompts[name]) throw new Error(`Prompt ${name} is already registered`);
        const { title, description, argsSchema, _meta } = config;
        const r = this.createRegisteredPrompt(
            name,
            title,
            description,
            coerceSchema(argsSchema),
            cb as PromptCallback<StandardSchemaWithJSON | undefined>,
            _meta
        );
        this.host.setPromptRequestHandlers();
        this.host.sendPromptListChanged();
        return r;
    }

    // ───────────────────────────────────────────────────────────────────────
    // Registered* factories. Exposed so legacy `.tool()`/`.prompt()`/`.resource()`
    // and `experimental.tasks.registerToolTask` can build entries directly.
    // ───────────────────────────────────────────────────────────────────────

    createRegisteredResource(
        name: string,
        title: string | undefined,
        uri: string,
        metadata: ResourceMetadata | undefined,
        readCallback: ReadResourceCallback
    ): RegisteredResource {
        const r: RegisteredResource = {
            name,
            title,
            metadata,
            readCallback,
            enabled: true,
            disable: () => r.update({ enabled: false }),
            enable: () => r.update({ enabled: true }),
            remove: () => r.update({ uri: null }),
            update: updates => {
                if (updates.uri !== undefined && updates.uri !== uri) {
                    delete this.registeredResources[uri];
                    if (updates.uri) this.registeredResources[updates.uri] = r;
                }
                if (updates.name !== undefined) r.name = updates.name;
                if (updates.title !== undefined) r.title = updates.title;
                if (updates.metadata !== undefined) r.metadata = updates.metadata;
                if (updates.callback !== undefined) r.readCallback = updates.callback;
                if (updates.enabled !== undefined) r.enabled = updates.enabled;
                this.host.sendResourceListChanged();
            }
        };
        this.registeredResources[uri] = r;
        return r;
    }

    createRegisteredResourceTemplate(
        name: string,
        title: string | undefined,
        template: ResourceTemplate,
        metadata: ResourceMetadata | undefined,
        readCallback: ReadResourceTemplateCallback
    ): RegisteredResourceTemplate {
        const r: RegisteredResourceTemplate = {
            resourceTemplate: template,
            title,
            metadata,
            readCallback,
            enabled: true,
            disable: () => r.update({ enabled: false }),
            enable: () => r.update({ enabled: true }),
            remove: () => r.update({ name: null }),
            update: updates => {
                if (updates.name !== undefined && updates.name !== name) {
                    delete this.registeredResourceTemplates[name];
                    if (updates.name) this.registeredResourceTemplates[updates.name] = r;
                }
                if (updates.title !== undefined) r.title = updates.title;
                if (updates.template !== undefined) r.resourceTemplate = updates.template;
                if (updates.metadata !== undefined) r.metadata = updates.metadata;
                if (updates.callback !== undefined) r.readCallback = updates.callback;
                if (updates.enabled !== undefined) r.enabled = updates.enabled;
                this.host.sendResourceListChanged();
            }
        };
        this.registeredResourceTemplates[name] = r;
        const variableNames = template.uriTemplate.variableNames;
        const hasCompleter = Array.isArray(variableNames) && variableNames.some(v => !!template.completeCallback(v));
        if (hasCompleter) this.host.setCompletionRequestHandler();
        return r;
    }

    createRegisteredPrompt(
        name: string,
        title: string | undefined,
        description: string | undefined,
        argsSchema: StandardSchemaWithJSON | undefined,
        callback: PromptCallback<StandardSchemaWithJSON | undefined>,
        _meta: Record<string, unknown> | undefined
    ): RegisteredPrompt {
        let currentArgsSchema = argsSchema;
        let currentCallback = callback;
        const r: RegisteredPrompt = {
            title,
            description,
            argsSchema,
            _meta,
            handler: createPromptHandler(name, argsSchema, callback),
            enabled: true,
            disable: () => r.update({ enabled: false }),
            enable: () => r.update({ enabled: true }),
            remove: () => r.update({ name: null }),
            update: updates => {
                if (updates.name !== undefined && updates.name !== name) {
                    delete this.registeredPrompts[name];
                    if (updates.name) this.registeredPrompts[updates.name] = r;
                }
                if (updates.title !== undefined) r.title = updates.title;
                if (updates.description !== undefined) r.description = updates.description;
                if (updates._meta !== undefined) r._meta = updates._meta;
                let needsRegen = false;
                if (updates.argsSchema !== undefined) {
                    r.argsSchema = updates.argsSchema;
                    currentArgsSchema = updates.argsSchema;
                    needsRegen = true;
                }
                if (updates.callback !== undefined) {
                    currentCallback = updates.callback as PromptCallback<StandardSchemaWithJSON | undefined>;
                    needsRegen = true;
                }
                if (needsRegen) r.handler = createPromptHandler(name, currentArgsSchema, currentCallback);
                if (updates.enabled !== undefined) r.enabled = updates.enabled;
                this.host.sendPromptListChanged();
            }
        };
        this.registeredPrompts[name] = r;
        if (argsSchema) {
            const shape = getSchemaShape(argsSchema);
            if (shape) {
                const hasCompletable = Object.values(shape).some(f => isCompletable(unwrapOptionalSchema(f)));
                if (hasCompletable) this.host.setCompletionRequestHandler();
            }
        }
        return r;
    }

    createRegisteredTool(
        name: string,
        title: string | undefined,
        description: string | undefined,
        inputSchema: StandardSchemaWithJSON | undefined,
        outputSchema: StandardSchemaWithJSON | undefined,
        annotations: ToolAnnotations | undefined,
        execution: ToolExecution | undefined,
        _meta: Record<string, unknown> | undefined,
        handler: AnyToolHandler<StandardSchemaWithJSON | undefined>
    ): RegisteredTool {
        validateAndWarnToolName(name);
        let currentHandler = handler;
        const r: RegisteredTool = {
            title,
            description,
            inputSchema,
            outputSchema,
            annotations,
            execution,
            _meta,
            handler,
            executor: createToolExecutor(inputSchema, handler),
            enabled: true,
            disable: () => r.update({ enabled: false }),
            enable: () => r.update({ enabled: true }),
            remove: () => r.update({ name: null }),
            update: updates => {
                if (updates.name !== undefined && updates.name !== name) {
                    if (typeof updates.name === 'string') validateAndWarnToolName(updates.name);
                    delete this.registeredTools[name];
                    if (updates.name) this.registeredTools[updates.name] = r;
                }
                if (updates.title !== undefined) r.title = updates.title;
                if (updates.description !== undefined) r.description = updates.description;
                let needsRegen = false;
                if (updates.paramsSchema !== undefined) {
                    r.inputSchema = updates.paramsSchema;
                    needsRegen = true;
                }
                if (updates.callback !== undefined) {
                    r.handler = updates.callback;
                    currentHandler = updates.callback as AnyToolHandler<StandardSchemaWithJSON | undefined>;
                    needsRegen = true;
                }
                if (needsRegen) r.executor = createToolExecutor(r.inputSchema, currentHandler);
                if (updates.outputSchema !== undefined) r.outputSchema = updates.outputSchema;
                if (updates.annotations !== undefined) r.annotations = updates.annotations;
                if (updates._meta !== undefined) r._meta = updates._meta;
                if (updates.enabled !== undefined) r.enabled = updates.enabled;
                this.host.sendToolListChanged();
            }
        };
        this.registeredTools[name] = r;
        this.host.setToolRequestHandlers();
        this.host.sendToolListChanged();
        return r;
    }

    /** Expose lazy installers for callers (legacy `.prompt()/.resource()`) that build entries via `create*` directly. */
    installResourceHandlers(): void {
        this.host.setResourceRequestHandlers();
    }
    installPromptHandlers(): void {
        this.host.setPromptRequestHandlers();
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────────────

export type BaseToolCallback<
    SendResultT extends Result,
    Ctx extends ServerContext,
    Args extends StandardSchemaWithJSON | undefined
> = Args extends StandardSchemaWithJSON
    ? (args: StandardSchemaWithJSON.InferOutput<Args>, ctx: Ctx) => SendResultT | Promise<SendResultT>
    : (ctx: Ctx) => SendResultT | Promise<SendResultT>;

export type ToolCallback<Args extends StandardSchemaWithJSON | undefined = undefined> = BaseToolCallback<
    CallToolResult,
    ServerContext,
    Args
>;

export type AnyToolHandler<Args extends StandardSchemaWithJSON | undefined = undefined> = ToolCallback<Args> | ToolTaskHandler<Args>;

type ToolExecutor = (args: unknown, ctx: ServerContext) => Promise<CallToolResult | CreateTaskResult>;

export type RegisteredTool = {
    title?: string;
    description?: string;
    inputSchema?: StandardSchemaWithJSON;
    outputSchema?: StandardSchemaWithJSON;
    annotations?: ToolAnnotations;
    execution?: ToolExecution;
    _meta?: Record<string, unknown>;
    handler: AnyToolHandler<StandardSchemaWithJSON | undefined>;
    /** @hidden */
    executor: ToolExecutor;
    enabled: boolean;
    enable(): void;
    disable(): void;
    update(updates: {
        name?: string | null;
        title?: string;
        description?: string;
        paramsSchema?: StandardSchemaWithJSON;
        outputSchema?: StandardSchemaWithJSON;
        annotations?: ToolAnnotations;
        _meta?: Record<string, unknown>;
        callback?: ToolCallback<StandardSchemaWithJSON>;
        enabled?: boolean;
    }): void;
    remove(): void;
};

export type ResourceMetadata = Omit<Resource, 'uri' | 'name'>;
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

export type PromptCallback<Args extends StandardSchemaWithJSON | undefined = undefined> = Args extends StandardSchemaWithJSON
    ? (args: StandardSchemaWithJSON.InferOutput<Args>, ctx: ServerContext) => GetPromptResult | Promise<GetPromptResult>
    : (ctx: ServerContext) => GetPromptResult | Promise<GetPromptResult>;

type PromptHandler = (args: Record<string, unknown> | undefined, ctx: ServerContext) => Promise<GetPromptResult>;
type ToolCallbackInternal = (args: unknown, ctx: ServerContext) => CallToolResult | Promise<CallToolResult>;
type TaskHandlerInternal = {
    createTask: (args: unknown, ctx: CreateTaskServerContext) => CreateTaskResult | Promise<CreateTaskResult>;
};

export type RegisteredPrompt = {
    title?: string;
    description?: string;
    argsSchema?: StandardSchemaWithJSON;
    _meta?: Record<string, unknown>;
    /** @hidden */
    handler: PromptHandler;
    enabled: boolean;
    enable(): void;
    disable(): void;
    update<Args extends StandardSchemaWithJSON>(updates: {
        name?: string | null;
        title?: string;
        description?: string;
        argsSchema?: Args;
        _meta?: Record<string, unknown>;
        callback?: PromptCallback<Args>;
        enabled?: boolean;
    }): void;
    remove(): void;
};

// Re-export for path compat.

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

const EMPTY_OBJECT_JSON_SCHEMA = { type: 'object' as const, properties: {} };
const EMPTY_COMPLETION_RESULT: CompleteResult = { completion: { values: [], hasMore: false } };

function createToolError(errorMessage: string): CallToolResult {
    return { content: [{ type: 'text', text: errorMessage }], isError: true };
}

function createCompletionResult(suggestions: readonly unknown[]): CompleteResult {
    const values = suggestions.map(String).slice(0, 100);
    return { completion: { values, total: suggestions.length, hasMore: suggestions.length > 100 } };
}

function createToolExecutor(
    inputSchema: StandardSchemaWithJSON | undefined,
    handler: AnyToolHandler<StandardSchemaWithJSON | undefined>
): ToolExecutor {
    const isTaskHandler = 'createTask' in handler;
    if (isTaskHandler) {
        const th = handler as TaskHandlerInternal;
        return async (args, ctx) => {
            if (!ctx.task?.store) throw new Error('No task store provided.');
            const taskCtx: CreateTaskServerContext = { ...ctx, task: { store: ctx.task.store, requestedTtl: ctx.task?.requestedTtl } };
            if (inputSchema) return th.createTask(args, taskCtx);
            return (th.createTask as (ctx: CreateTaskServerContext) => CreateTaskResult | Promise<CreateTaskResult>)(taskCtx);
        };
    }
    if (inputSchema) {
        const cb = handler as ToolCallbackInternal;
        return async (args, ctx) => cb(args, ctx);
    }
    const cb = handler as (ctx: ServerContext) => CallToolResult | Promise<CallToolResult>;
    return async (_args, ctx) => cb(ctx);
}

function createPromptHandler(
    name: string,
    argsSchema: StandardSchemaWithJSON | undefined,
    callback: PromptCallback<StandardSchemaWithJSON | undefined>
): PromptHandler {
    if (argsSchema) {
        const typed = callback as (args: unknown, ctx: ServerContext) => GetPromptResult | Promise<GetPromptResult>;
        return async (args, ctx) => {
            const parsed = await validateStandardSchema(argsSchema, args);
            if (!parsed.success) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid arguments for prompt ${name}: ${parsed.error}`);
            }
            return typed(parsed.data, ctx);
        };
    }
    const typed = callback as (ctx: ServerContext) => GetPromptResult | Promise<GetPromptResult>;
    return async (_args, ctx) => typed(ctx);
}

function getSchemaShape(schema: unknown): Record<string, unknown> | undefined {
    const c = schema as { shape?: unknown };
    if (c.shape && typeof c.shape === 'object') return c.shape as Record<string, unknown>;
    return undefined;
}

function isOptionalSchema(schema: unknown): boolean {
    return (schema as { type?: string } | null | undefined)?.type === 'optional';
}

function unwrapOptionalSchema(schema: unknown): unknown {
    if (!isOptionalSchema(schema)) return schema;
    const c = schema as { def?: { innerType?: unknown } };
    return c.def?.innerType ?? schema;
}

export { type ListResourcesCallback } from './resourceTemplate.js';
