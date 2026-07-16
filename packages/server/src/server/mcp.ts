import type {
    BaseMetadata,
    CacheHint,
    CallToolResult,
    CompleteRequestPrompt,
    CompleteRequestResourceTemplate,
    CompleteResult,
    GetPromptResult,
    HandlerResultTypeMap,
    Icon,
    Implementation,
    InputRequiredResult,
    ListPromptsResult,
    ListResourcesResult,
    ListToolsResult,
    LoggingMessageNotification,
    Prompt,
    PromptReference,
    ReadResourceResult,
    RequestTypeMap,
    Resource,
    ResourceTemplateReference,
    Result,
    ServerContext,
    StandardSchemaWithJSON,
    Tool,
    ToolAnnotations,
    ToolExecution,
    Transport,
    Variables
} from '@modelcontextprotocol/core-internal';
import {
    assertCompleteRequestPrompt,
    assertCompleteRequestResourceTemplate,
    assertValidCacheHint,
    attachCacheHintFallback,
    isInputRequiredResult,
    normalizeRawShapeSchema,
    promptArgumentsFromStandardSchema,
    ProtocolError,
    ProtocolErrorCode,
    ResourceNotFoundError,
    scanXMcpHeaderDeclarations,
    standardSchemaToJsonSchema,
    UriTemplate,
    validateAndWarnToolName,
    validateStandardSchema
} from '@modelcontextprotocol/core-internal';
import type * as z from 'zod/v4';

import { getCompleter, isCompletable } from './completable';
import type { AroundMcpRequest, McpRequestMethod, ServerOptions } from './server';
import { Server } from './server';

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

    private readonly _aroundMcpRequest?: AroundMcpRequest;

    private _registeredResources: { [uri: string]: RegisteredResource } = {};
    private _registeredResourceTemplates: {
        [name: string]: RegisteredResourceTemplate;
    } = {};
    private _registeredTools: { [name: string]: RegisteredTool } = {};
    private _registeredPrompts: { [name: string]: RegisteredPrompt } = {};
    private readonly _promptExecutors = new WeakMap<RegisteredPrompt, PromptExecutor>();
    /**
     * Per-tool JSON-converted `inputSchema`, memoized so the SEP-2243
     * registration-time scan and the pre-dispatch validation step share one
     * conversion instead of paying it twice per request under the
     * per-request-factory `createMcpHandler` model.
     */
    private _toolInputSchemaJson: { [name: string]: Record<string, unknown> } = {};

    /**
     * The JSON-serialized `inputSchema` of a registered tool, or `undefined`
     * when no such tool is registered. Used by the HTTP entry's pre-dispatch
     * SEP-2243 `Mcp-Param-*` validation step (which needs the same JSON Schema
     * `tools/list` would emit, before dispatch reaches the handler).
     *
     * @internal
     */
    toolInputSchemaJson(name: string): Record<string, unknown> | undefined {
        const tool = this._registeredTools[name];
        if (tool === undefined || !tool.enabled) return undefined;
        if (Object.hasOwn(this._toolInputSchemaJson, name)) return this._toolInputSchemaJson[name];
        if (tool.inputSchema === undefined) return EMPTY_OBJECT_JSON_SCHEMA;
        // Lazy path: the memo slot is unset because `registerTool`'s eager
        // conversion threw (and was swallowed per its "warn, never throw"
        // contract) or `update({paramsSchema})`/rename invalidated it. The
        // pre-dispatch SEP-2243 caller must not turn that into a 500 for a
        // `tools/call` whose body-authoritative dispatch would otherwise
        // succeed — return `undefined` so validation is skipped and the
        // conversion failure stays where it always surfaced (`tools/list`).
        // A successful re-derive is memoized so the per-request-factory
        // `createMcpHandler` model does not re-convert on every call.
        try {
            const json = standardSchemaToJsonSchema(tool.inputSchema, 'input');
            this._toolInputSchemaJson[name] = json;
            return json;
        } catch {
            return undefined;
        }
    }

    constructor(serverInfo: Implementation, options?: ServerOptions) {
        this.server = new Server(serverInfo, options);
        this._aroundMcpRequest = options?.aroundMcpRequest;

        // Per the MCP spec, a server that declares a primitive capability MUST respond to its
        // list method (potentially with an empty result) rather than "Method not found" — even
        // if nothing has been registered yet. Handlers are normally installed lazily on first
        // registration, so eagerly install them here for any capability declared up front.
        // (Users of the low-level `Server` class remain responsible for their own handlers.)
        if (options?.capabilities?.tools) {
            this.setToolRequestHandlers();
        }
        if (options?.capabilities?.resources) {
            this.setResourceRequestHandlers();
        }
        if (options?.capabilities?.prompts) {
            this.setPromptRequestHandlers();
        }
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

    /** Invokes the configured high-level operation interceptor, when present. */
    private async invokeAroundMcpRequest<M extends McpRequestMethod>(
        method: M,
        request: RequestTypeMap[M],
        ctx: ServerContext,
        next: () => Promise<HandlerResultTypeMap[M]>
    ): Promise<HandlerResultTypeMap[M]> {
        return this._aroundMcpRequest ? this._aroundMcpRequest(method, request, ctx, next) : next();
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

        // Note: tools are listed in registration (insertion) order, which keeps the ordering
        // deterministic across requests when the underlying tool set has not changed, as
        // recommended by the spec.
        this.server.setRequestHandler(
            'tools/list',
            (request, ctx): Promise<ListToolsResult> =>
                this.invokeAroundMcpRequest('tools/list', request, ctx, async () => ({
                    tools: Object.entries(this._registeredTools)
                        .filter(([, tool]) => tool.enabled)
                        .map(([name, tool]): Tool => {
                            const toolDefinition: Tool = {
                                name,
                                title: tool.title,
                                description: tool.description,
                                inputSchema: tool.inputSchema
                                    ? (standardSchemaToJsonSchema(tool.inputSchema, 'input') as Tool['inputSchema'])
                                    : EMPTY_OBJECT_JSON_SCHEMA,
                                annotations: tool.annotations,
                                icons: tool.icons,
                                execution: tool.execution,
                                _meta: tool._meta
                            };

                            if (tool.outputSchema) {
                                // SEP-2106 legacy interop (non-object outputSchema roots wrapped in
                                // `{type:'object',properties:{result:<natural>},required:['result']}` toward
                                // 2025-era clients) lives in the 2025 wire codec's `encodeResult('tools/list', …)`
                                // — this handler is era-blind and emits the natural converted schema.
                                toolDefinition.outputSchema = standardSchemaToJsonSchema(
                                    tool.outputSchema,
                                    'output'
                                ) as Tool['outputSchema'];
                            }

                            return toolDefinition;
                        })
                }))
        );

        this.server.setRequestHandler('tools/call', async (request, ctx): Promise<CallToolResult | InputRequiredResult> => {
            const tool = this._registeredTools[request.params.name];
            if (!tool) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
            }
            if (!tool.enabled) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${request.params.name} disabled`);
            }

            try {
                const args = await this.validateToolInput(tool, request.params.arguments, request.params.name);
                const validatedRequest: RequestTypeMap['tools/call'] = {
                    ...request,
                    params: { ...request.params, arguments: args }
                };
                const result = await this.invokeAroundMcpRequest('tools/call', validatedRequest, ctx, () =>
                    this.executeToolHandler(tool, args, ctx)
                );
                await this.validateToolOutput(tool, result, request.params.name);
                if (isInputRequiredResult(result)) return result;
                // SEP-2106 result-side projection (the era-agnostic TextContent auto-append; the
                // `{result:…}` wrap on the 2025 era) lives behind the wire codec's
                // `projectCallToolResult`. The codec receives the SAME advertised JSON Schema
                // `tools/list` emits (and that the codec's `encodeResult('tools/list', …)` may have
                // wrapped) so the listing and the call cannot diverge.
                return this.server.projectCallToolResult(result, tool.outputSchemaJson);
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
        ToolType extends RegisteredTool,
        Args extends ToolType['inputSchema'] extends infer InputSchema
            ? InputSchema extends StandardSchemaWithJSON
                ? StandardSchemaWithJSON.InferOutput<InputSchema>
                : undefined
            : undefined
    >(tool: ToolType, args: Args, toolName: string): Promise<Args> {
        if (!tool.inputSchema) {
            return undefined as Args;
        }

        const parseResult = await validateStandardSchema(tool.inputSchema, args ?? {});
        if (!parseResult.success) {
            throw new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                `Input validation error: Invalid arguments for tool ${toolName}: ${parseResult.error}`
            );
        }

        return parseResult.data as unknown as Args;
    }

    /**
     * Validates tool output against the tool's output schema.
     */
    private async validateToolOutput(tool: RegisteredTool, result: CallToolResult | InputRequiredResult, toolName: string): Promise<void> {
        if (!tool.outputSchema) {
            return;
        }

        // An input-required result is not the tool's final output: structured
        // content is only required (and validated) on the completing result.
        if (isInputRequiredResult(result)) {
            return;
        }

        if (result.isError) {
            return;
        }

        // SEP-2106: `structuredContent` may legally be any JSON value including `null`, `0`,
        // `false`, `""`. The presence check is therefore `=== undefined` (not falsy); when present,
        // the value is ALWAYS validated against the output schema — a falsy value against an
        // object-typed schema fails validation, so this is not a guard weakening.
        if (result.structuredContent === undefined) {
            throw new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                `Output validation error: Tool ${toolName} has an output schema but no structured content was provided`
            );
        }

        // if the tool has an output schema, validate structured content
        const parseResult = await validateStandardSchema(tool.outputSchema, result.structuredContent);
        if (!parseResult.success) {
            throw new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                `Output validation error: Invalid structured content for tool ${toolName}: ${parseResult.error}`
            );
        }
    }

    /**
     * Executes a tool handler.
     */
    private async executeToolHandler(
        tool: RegisteredTool,
        args: unknown,
        ctx: ServerContext
    ): Promise<CallToolResult | InputRequiredResult> {
        // Executor encapsulates handler invocation with proper types
        return tool.executor(args, ctx);
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
        const field = unwrapOptionalSchema(promptShape?.[request.params.argument.name]);
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

        this.server.setRequestHandler('resources/list', (request, ctx) =>
            this.invokeAroundMcpRequest('resources/list', request, ctx, async () => {
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
            })
        );

        this.server.setRequestHandler('resources/templates/list', (request, ctx) =>
            this.invokeAroundMcpRequest('resources/templates/list', request, ctx, async () => {
                const resourceTemplates = Object.entries(this._registeredResourceTemplates).map(([name, template]) => ({
                    name,
                    uriTemplate: template.resourceTemplate.uriTemplate.toString(),
                    ...template.metadata
                }));

                return { resourceTemplates };
            })
        );

        this.server.setRequestHandler('resources/read', async (request, ctx) => {
            let uri: URL;
            try {
                uri = new URL(request.params.uri);
            } catch {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource URI ${request.params.uri} is invalid`, {
                    uri: request.params.uri,
                    reason: 'invalid_uri'
                });
            }

            // First check for exact resource match
            const resource = this._registeredResources[uri.toString()];
            if (resource) {
                if (!resource.enabled) {
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource ${uri} disabled`);
                }
                // A per-resource cache hint is the most specific configured
                // author for this result's 2026-07-28 cache fields; it rides a
                // never-serialized carrier and is resolved at the encode seam.
                const result = await this.invokeAroundMcpRequest(
                    'resources/read',
                    request,
                    ctx,
                    async () => await resource.readCallback(uri, ctx)
                );
                return attachCacheHintFallback(result, resource.cacheHint);
            }

            // Then check templates
            for (const template of Object.values(this._registeredResourceTemplates)) {
                const variables = template.resourceTemplate.uriTemplate.match(uri.toString());
                if (variables) {
                    const result = await this.invokeAroundMcpRequest(
                        'resources/read',
                        request,
                        ctx,
                        async () => await template.readCallback(uri, variables, ctx)
                    );
                    return attachCacheHintFallback(result, template.cacheHint);
                }
            }

            // Domain layer throws one neutral resource-not-found error; the
            // era-aware encode seam (WireCodec.encodeErrorCode) selects the
            // wire code (−32602 on every era).
            throw new ResourceNotFoundError(request.params.uri);
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
            (request, ctx): Promise<ListPromptsResult> =>
                this.invokeAroundMcpRequest('prompts/list', request, ctx, async () => ({
                    prompts: Object.entries(this._registeredPrompts)
                        .filter(([, prompt]) => prompt.enabled)
                        .map(([name, prompt]): Prompt => {
                            return {
                                name,
                                title: prompt.title,
                                description: prompt.description,
                                arguments: prompt.argsSchema ? promptArgumentsFromStandardSchema(prompt.argsSchema) : undefined,
                                icons: prompt.icons,
                                _meta: prompt._meta
                            };
                        })
                }))
        );

        this.server.setRequestHandler('prompts/get', async (request, ctx): Promise<GetPromptResult | InputRequiredResult> => {
            const prompt = this._registeredPrompts[request.params.name];
            if (!prompt) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Prompt ${request.params.name} not found`);
            }

            if (!prompt.enabled) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Prompt ${request.params.name} disabled`);
            }

            const args = await this.validatePromptInput(prompt, request.params.arguments, request.params.name);
            const executor = this._promptExecutors.get(prompt);
            if (!executor) {
                throw new ProtocolError(ProtocolErrorCode.InternalError, `Prompt ${request.params.name} has no executor`);
            }
            return this.invokeAroundMcpRequest('prompts/get', request, ctx, () => executor(args, ctx));
        });

        this._promptHandlersInitialized = true;
    }

    /** Validates prompt arguments before routing through the operation interceptor. */
    private async validatePromptInput(
        prompt: RegisteredPrompt,
        args: RequestTypeMap['prompts/get']['params']['arguments'],
        promptName: string
    ): Promise<unknown> {
        if (!prompt.argsSchema) {
            return undefined;
        }

        const parseResult = await validateStandardSchema(prompt.argsSchema, args);
        if (!parseResult.success) {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid arguments for prompt ${promptName}: ${parseResult.error}`);
        }
        return parseResult.data;
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
    registerResource(
        name: string,
        uriOrTemplate: string,
        config: ResourceMetadata & { cacheHint?: CacheHint },
        readCallback: ReadResourceCallback
    ): RegisteredResource;
    registerResource(
        name: string,
        uriOrTemplate: ResourceTemplate,
        config: ResourceMetadata & { cacheHint?: CacheHint },
        readCallback: ReadResourceTemplateCallback
    ): RegisteredResourceTemplate;
    registerResource(
        name: string,
        uriOrTemplate: string | ResourceTemplate,
        config: ResourceMetadata & { cacheHint?: CacheHint },
        readCallback: ReadResourceCallback | ReadResourceTemplateCallback
    ): RegisteredResource | RegisteredResourceTemplate {
        // The cache hint configures the encode-time cache fields of this
        // resource's `resources/read` results (2026-07-28); it is not resource
        // metadata and never appears on `resources/list` entries.
        const cacheHint = config.cacheHint;
        let metadata: ResourceMetadata = config;
        if (cacheHint !== undefined) {
            assertValidCacheHint(cacheHint, `resource ${name}`);
            const rest = { ...config };
            delete rest.cacheHint;
            metadata = rest;
        }

        if (typeof uriOrTemplate === 'string') {
            if (this._registeredResources[uriOrTemplate]) {
                throw new Error(`Resource ${uriOrTemplate} is already registered`);
            }

            const registeredResource = this._createRegisteredResource(
                name,
                (config as BaseMetadata).title,
                uriOrTemplate,
                metadata,
                readCallback as ReadResourceCallback
            );
            if (cacheHint !== undefined) {
                registeredResource.cacheHint = cacheHint;
            }

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
                metadata,
                readCallback as ReadResourceTemplateCallback
            );
            if (cacheHint !== undefined) {
                registeredResourceTemplate.cacheHint = cacheHint;
            }

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
        argsSchema: StandardSchemaWithJSON | undefined,
        callback: PromptCallback<StandardSchemaWithJSON | undefined>,
        icons: Icon[] | undefined,
        _meta: Record<string, unknown> | undefined
    ): RegisteredPrompt {
        // Track current schema and callback for handler regeneration
        let currentArgsSchema = argsSchema;
        let currentCallback = callback;
        const registeredPrompt: RegisteredPrompt = {
            title,
            description,
            argsSchema,
            icons,
            _meta,
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
                if (updates.icons !== undefined) registeredPrompt.icons = updates.icons;
                if (updates._meta !== undefined) registeredPrompt._meta = updates._meta;

                // Track if we need to regenerate the handler
                let needsHandlerRegen = false;
                if (updates.argsSchema !== undefined) {
                    registeredPrompt.argsSchema = updates.argsSchema;
                    currentArgsSchema = updates.argsSchema;
                    needsHandlerRegen = true;
                }
                if (updates.callback !== undefined) {
                    currentCallback = updates.callback as PromptCallback<StandardSchemaWithJSON | undefined>;
                    needsHandlerRegen = true;
                }
                if (needsHandlerRegen) {
                    registeredPrompt.handler = createPromptHandler(name, currentArgsSchema, currentCallback);
                    this._promptExecutors.set(registeredPrompt, createPromptExecutor(currentArgsSchema, currentCallback));
                }

                if (updates.enabled !== undefined) registeredPrompt.enabled = updates.enabled;
                this.sendPromptListChanged();
            }
        };
        this._registeredPrompts[name] = registeredPrompt;
        this._promptExecutors.set(registeredPrompt, createPromptExecutor(argsSchema, callback));

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
        inputSchema: StandardSchemaWithJSON | undefined,
        outputSchema: StandardSchemaWithJSON | undefined,
        annotations: ToolAnnotations | undefined,
        icons: Icon[] | undefined,
        execution: ToolExecution | undefined,
        _meta: Record<string, unknown> | undefined,
        handler: AnyToolHandler<StandardSchemaWithJSON | undefined>
    ): RegisteredTool {
        // Validate tool name according to SEP specification
        validateAndWarnToolName(name);

        // SEP-2243 registration-time declaration-validity check (additive: warn,
        // never throw — clients enforce by exclusion, servers by header
        // validation; a malformed declaration here should not block local
        // development against a stdio client that ignores it). The conversion
        // is memoized so the pre-dispatch validation step in `createMcpHandler`
        // (and `toolInputSchemaJson()`) does not repeat it for the same tool.
        // `standardSchemaToJsonSchema` can throw for schemas it cannot convert
        // (e.g. a vendor without `~standard.jsonSchema`); the try/catch keeps
        // the "warn, never throw" contract.
        if (inputSchema !== undefined) {
            try {
                const json = standardSchemaToJsonSchema(inputSchema, 'input');
                this._toolInputSchemaJson[name] = json;
                const scan = scanXMcpHeaderDeclarations(json);
                if (!scan.valid) {
                    console.warn(
                        `[mcp-sdk] tool '${name}' carries an invalid x-mcp-header declaration and will be excluded by ` +
                            `conforming Streamable HTTP clients: ${scan.reason}`
                    );
                }
            } catch {
                // Conversion failure: leave the cache slot unset so the lazy
                // path in `toolInputSchemaJson()` (and `tools/list`) surfaces
                // the failure where it always has.
            }
        }

        // Track current handler for executor regeneration
        let currentHandler = handler;

        const registeredTool: RegisteredTool = {
            title,
            description,
            inputSchema,
            outputSchema,
            outputSchemaJson: convertOutputSchemaJson(outputSchema),
            annotations,
            icons,
            execution,
            _meta,
            handler: handler,
            executor: createToolExecutor(inputSchema, handler),
            enabled: true,
            disable: () => registeredTool.update({ enabled: false }),
            enable: () => registeredTool.update({ enabled: true }),
            remove: () => registeredTool.update({ name: null }),
            update: updates => {
                // The closure's `name` tracks the CURRENT registry key, not
                // the original registration name — renaming reassigns it so
                // subsequent paramsSchema/rename invalidations evict the live
                // `_toolInputSchemaJson` slot rather than the original.
                if (updates.name !== undefined && updates.name !== name) {
                    if (typeof updates.name === 'string') {
                        validateAndWarnToolName(updates.name);
                    }
                    delete this._registeredTools[name];
                    delete this._toolInputSchemaJson[name];
                    if (updates.name) {
                        // The TARGET key may already be occupied by another
                        // tool (rename has no duplicate-name guard) — drop
                        // its memo too, otherwise `toolInputSchemaJson()`
                        // returns the displaced tool's converted schema and
                        // the SEP-2243 pre-dispatch validation runs against
                        // the wrong schema for this name.
                        delete this._toolInputSchemaJson[updates.name];
                        this._registeredTools[updates.name] = registeredTool;
                        name = updates.name;
                    }
                }
                if (updates.title !== undefined) registeredTool.title = updates.title;
                if (updates.description !== undefined) registeredTool.description = updates.description;

                // Track if we need to regenerate the executor
                let needsExecutorRegen = false;
                if (updates.paramsSchema !== undefined) {
                    registeredTool.inputSchema = updates.paramsSchema;
                    delete this._toolInputSchemaJson[name];
                    needsExecutorRegen = true;
                }
                if (updates.callback !== undefined) {
                    registeredTool.handler = updates.callback;
                    currentHandler = updates.callback as AnyToolHandler<StandardSchemaWithJSON | undefined>;
                    needsExecutorRegen = true;
                }
                if (needsExecutorRegen) {
                    registeredTool.executor = createToolExecutor(registeredTool.inputSchema, currentHandler);
                }

                if (updates.outputSchema !== undefined) {
                    registeredTool.outputSchema = updates.outputSchema;
                    registeredTool.outputSchemaJson = convertOutputSchemaJson(updates.outputSchema);
                }
                if (updates.annotations !== undefined) registeredTool.annotations = updates.annotations;
                if (updates.icons !== undefined) registeredTool.icons = updates.icons;
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
    registerTool<OutputArgs extends StandardSchemaWithJSON, InputArgs extends StandardSchemaWithJSON | undefined = undefined>(
        name: string,
        config: {
            title?: string;
            description?: string;
            inputSchema?: InputArgs;
            outputSchema?: OutputArgs;
            annotations?: ToolAnnotations;
            icons?: Icon[];
            _meta?: Record<string, unknown>;
        },
        cb: ToolCallback<InputArgs>
    ): RegisteredTool;
    /** @deprecated Wrap with `z.object({...})` instead. Raw-shape form: `inputSchema`/`outputSchema` may be a plain `{ field: z.string() }` record; it is auto-wrapped with `z.object()`. */
    registerTool<InputArgs extends ZodRawShape, OutputArgs extends ZodRawShape | StandardSchemaWithJSON | undefined = undefined>(
        name: string,
        config: {
            title?: string;
            description?: string;
            inputSchema?: InputArgs;
            outputSchema?: OutputArgs;
            annotations?: ToolAnnotations;
            icons?: Icon[];
            _meta?: Record<string, unknown>;
        },
        cb: LegacyToolCallback<InputArgs>
    ): RegisteredTool;
    registerTool(
        name: string,
        config: {
            title?: string;
            description?: string;
            inputSchema?: StandardSchemaWithJSON | ZodRawShape;
            outputSchema?: StandardSchemaWithJSON | ZodRawShape;
            annotations?: ToolAnnotations;
            icons?: Icon[];
            _meta?: Record<string, unknown>;
        },
        cb: ToolCallback<StandardSchemaWithJSON | undefined> | LegacyToolCallback<ZodRawShape>
    ): RegisteredTool {
        if (this._registeredTools[name]) {
            throw new Error(`Tool ${name} is already registered`);
        }

        const { title, description, inputSchema, outputSchema, annotations, icons, _meta } = config;

        return this._createRegisteredTool(
            name,
            title,
            description,
            normalizeRawShapeSchema(inputSchema),
            normalizeRawShapeSchema(outputSchema),
            annotations,
            icons,
            undefined,
            _meta,
            cb as ToolCallback<StandardSchemaWithJSON | undefined>
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
    registerPrompt<Args extends StandardSchemaWithJSON>(
        name: string,
        config: {
            title?: string;
            description?: string;
            argsSchema?: Args;
            icons?: Icon[];
            _meta?: Record<string, unknown>;
        },
        cb: PromptCallback<Args>
    ): RegisteredPrompt;
    /** @deprecated Wrap with `z.object({...})` instead. Raw-shape form: `argsSchema` may be a plain `{ field: z.string() }` record; it is auto-wrapped with `z.object()`. */
    registerPrompt<Args extends ZodRawShape>(
        name: string,
        config: {
            title?: string;
            description?: string;
            argsSchema?: Args;
            icons?: Icon[];
            _meta?: Record<string, unknown>;
        },
        cb: LegacyPromptCallback<Args>
    ): RegisteredPrompt;
    registerPrompt(
        name: string,
        config: {
            title?: string;
            description?: string;
            argsSchema?: StandardSchemaWithJSON | ZodRawShape;
            icons?: Icon[];
            _meta?: Record<string, unknown>;
        },
        cb: PromptCallback<StandardSchemaWithJSON> | LegacyPromptCallback<ZodRawShape>
    ): RegisteredPrompt {
        if (this._registeredPrompts[name]) {
            throw new Error(`Prompt ${name} is already registered`);
        }

        const { title, description, argsSchema, icons, _meta } = config;

        const registeredPrompt = this._createRegisteredPrompt(
            name,
            title,
            description,
            normalizeRawShapeSchema(argsSchema),
            cb as PromptCallback<StandardSchemaWithJSON | undefined>,
            icons,
            _meta
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
     *
     * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
     * Remains functional during the deprecation window (at least twelve months).
     * Migrate to stderr logging (STDIO servers) or OpenTelemetry.
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

/**
 * A plain record of Zod field schemas, e.g. `{ name: z.string() }`. Accepted by
 * `registerTool`/`registerPrompt` as a shorthand; auto-wrapped with `z.object()`.
 * Zod schemas only — `z.object()` cannot wrap other Standard Schema libraries.
 */
export type ZodRawShape = Record<string, z.ZodType>;

/** Infers the parsed-output type of a {@linkcode ZodRawShape}. */
export type InferRawShape<S extends ZodRawShape> = z.infer<z.ZodObject<S>>;

/** {@linkcode ToolCallback} variant used when `inputSchema` is a {@linkcode ZodRawShape}. */
export type LegacyToolCallback<Args extends ZodRawShape | undefined> = Args extends ZodRawShape
    ? (
          args: InferRawShape<Args>,
          ctx: ServerContext
      ) => CallToolResult | InputRequiredResult | Promise<CallToolResult | InputRequiredResult>
    : (ctx: ServerContext) => CallToolResult | InputRequiredResult | Promise<CallToolResult | InputRequiredResult>;

/** {@linkcode PromptCallback} variant used when `argsSchema` is a {@linkcode ZodRawShape}. */
export type LegacyPromptCallback<Args extends ZodRawShape | undefined> = Args extends ZodRawShape
    ? (
          args: InferRawShape<Args>,
          ctx: ServerContext
      ) => GetPromptResult | InputRequiredResult | Promise<GetPromptResult | InputRequiredResult>
    : (ctx: ServerContext) => GetPromptResult | InputRequiredResult | Promise<GetPromptResult | InputRequiredResult>;

export type BaseToolCallback<
    SendResultT extends Result,
    Ctx extends ServerContext,
    Args extends StandardSchemaWithJSON | undefined
> = Args extends StandardSchemaWithJSON
    ? (args: StandardSchemaWithJSON.InferOutput<Args>, ctx: Ctx) => SendResultT | Promise<SendResultT>
    : (ctx: Ctx) => SendResultT | Promise<SendResultT>;

/**
 * Callback for a tool handler registered with {@linkcode McpServer.registerTool}.
 */
export type ToolCallback<Args extends StandardSchemaWithJSON | undefined = undefined> = BaseToolCallback<
    CallToolResult | InputRequiredResult,
    ServerContext,
    Args
>;

/**
 * Tool handler callback type.
 */
export type AnyToolHandler<Args extends StandardSchemaWithJSON | undefined = undefined> = ToolCallback<Args>;

/**
 * Internal executor type that encapsulates handler invocation with proper types.
 */
type ToolExecutor = (args: unknown, ctx: ServerContext) => Promise<CallToolResult | InputRequiredResult>;

export type RegisteredTool = {
    title?: string;
    description?: string;
    inputSchema?: StandardSchemaWithJSON;
    outputSchema?: StandardSchemaWithJSON;
    /**
     * @hidden
     * The converted JSON Schema of `outputSchema`, memoised at registration (and on
     * `update({outputSchema})`) so the `tools/call` handler passes the SAME advertised schema
     * `tools/list` emits to the wire codec's `projectCallToolResult` — the SEP-2106 `{result:…}`
     * wrap predicate follows the schema's root, never the runtime value shape. `undefined` when
     * no `outputSchema` is registered or its conversion threw (see {@link convertOutputSchemaJson}).
     */
    outputSchemaJson?: Record<string, unknown>;
    annotations?: ToolAnnotations;
    icons?: Icon[];
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
        icons?: Icon[];
        _meta?: Record<string, unknown>;
        callback?: ToolCallback<StandardSchemaWithJSON>;
        enabled?: boolean;
    }): void;
    remove(): void;
};

/**
 * Creates an executor that invokes the handler with the appropriate arguments.
 * When `inputSchema` is defined, the handler is called with `(args, ctx)`.
 * When `inputSchema` is undefined, the handler is called with just `(ctx)`.
 */
function createToolExecutor(
    inputSchema: StandardSchemaWithJSON | undefined,
    handler: AnyToolHandler<StandardSchemaWithJSON | undefined>
): ToolExecutor {
    if (inputSchema) {
        const callback = handler as ToolCallbackInternal;
        return async (args, ctx) => callback(args, ctx);
    }

    // When no inputSchema, call with just ctx (the handler expects (ctx) signature)
    const callback = handler as (
        ctx: ServerContext
    ) => CallToolResult | InputRequiredResult | Promise<CallToolResult | InputRequiredResult>;
    return async (_args, ctx) => callback(ctx);
}

const EMPTY_OBJECT_JSON_SCHEMA = {
    type: 'object' as const,
    properties: {}
};

/**
 * Convert a registered `outputSchema` to JSON Schema, memoised on {@link RegisteredTool.outputSchemaJson}
 * so `tools/call` passes the SAME advertised schema to the wire codec's `projectCallToolResult` that
 * `tools/list` emits (and that the 2025 codec's `encodeResult('tools/list', …)` may wrap). A conversion
 * failure yields `undefined` so the failure surfaces where it always has (`tools/list`).
 */
function convertOutputSchemaJson(outputSchema: StandardSchemaWithJSON | undefined): Record<string, unknown> | undefined {
    if (outputSchema === undefined) return undefined;
    try {
        return standardSchemaToJsonSchema(outputSchema, 'output');
    } catch {
        return undefined;
    }
}

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
export type ReadResourceCallback = (
    uri: URL,
    ctx: ServerContext
) => ReadResourceResult | InputRequiredResult | Promise<ReadResourceResult | InputRequiredResult>;

export type RegisteredResource = {
    name: string;
    title?: string;
    metadata?: ResourceMetadata;
    /** Cache hint applied to this resource's `resources/read` results on the 2026-07-28 revision. */
    cacheHint?: CacheHint;
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
) => ReadResourceResult | InputRequiredResult | Promise<ReadResourceResult | InputRequiredResult>;

export type RegisteredResourceTemplate = {
    resourceTemplate: ResourceTemplate;
    title?: string;
    metadata?: ResourceMetadata;
    /** Cache hint applied to this template's `resources/read` results on the 2026-07-28 revision. */
    cacheHint?: CacheHint;
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
    ? (
          args: StandardSchemaWithJSON.InferOutput<Args>,
          ctx: ServerContext
      ) => GetPromptResult | InputRequiredResult | Promise<GetPromptResult | InputRequiredResult>
    : (ctx: ServerContext) => GetPromptResult | InputRequiredResult | Promise<GetPromptResult | InputRequiredResult>;

/**
 * Internal handler type that encapsulates parsing and callback invocation.
 * This allows type-safe handling without runtime type assertions.
 */
type PromptHandler = (args: Record<string, unknown> | undefined, ctx: ServerContext) => Promise<GetPromptResult | InputRequiredResult>;

/** Invokes a prompt callback with arguments that have already been validated. */
type PromptExecutor = (args: unknown, ctx: ServerContext) => Promise<GetPromptResult | InputRequiredResult>;

type ToolCallbackInternal = (
    args: unknown,
    ctx: ServerContext
) => CallToolResult | InputRequiredResult | Promise<CallToolResult | InputRequiredResult>;

export type RegisteredPrompt = {
    title?: string;
    description?: string;
    argsSchema?: StandardSchemaWithJSON;
    icons?: Icon[];
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
        icons?: Icon[];
        _meta?: Record<string, unknown>;
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
    argsSchema: StandardSchemaWithJSON | undefined,
    callback: PromptCallback<StandardSchemaWithJSON | undefined>
): PromptHandler {
    const executor = createPromptExecutor(argsSchema, callback);
    if (argsSchema) {
        return async (args, ctx) => {
            const parseResult = await validateStandardSchema(argsSchema, args);
            if (!parseResult.success) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid arguments for prompt ${name}: ${parseResult.error}`);
            }
            return executor(parseResult.data, ctx);
        };
    }

    return async (_args, ctx) => executor(undefined, ctx);
}

/** Creates an executor for prompt arguments that were validated by the caller. */
function createPromptExecutor(
    argsSchema: StandardSchemaWithJSON | undefined,
    callback: PromptCallback<StandardSchemaWithJSON | undefined>
): PromptExecutor {
    if (argsSchema) {
        const typedCallback = callback as (
            args: unknown,
            ctx: ServerContext
        ) => GetPromptResult | InputRequiredResult | Promise<GetPromptResult | InputRequiredResult>;
        return async (args, ctx) => typedCallback(args, ctx);
    }

    const typedCallback = callback as (
        ctx: ServerContext
    ) => GetPromptResult | InputRequiredResult | Promise<GetPromptResult | InputRequiredResult>;
    return async (_args, ctx) => typedCallback(ctx);
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

/** @internal Gets the shape of a Zod object schema */
function getSchemaShape(schema: unknown): Record<string, unknown> | undefined {
    const candidate = schema as { shape?: unknown };
    if (candidate.shape && typeof candidate.shape === 'object') {
        return candidate.shape as Record<string, unknown>;
    }
    return undefined;
}

/** @internal Checks if a Zod schema is optional */
function isOptionalSchema(schema: unknown): boolean {
    const candidate = schema as { type?: string } | null | undefined;
    return candidate?.type === 'optional';
}

/** @internal Unwraps an optional Zod schema */
function unwrapOptionalSchema(schema: unknown): unknown {
    if (!isOptionalSchema(schema)) {
        return schema;
    }
    const candidate = schema as { def?: { innerType?: unknown } };
    return candidate.def?.innerType ?? schema;
}
