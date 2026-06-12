import type {
    BaseMetadata,
    CallToolResult,
    CompleteRequestPrompt,
    CompleteRequestResourceTemplate,
    CompleteResult,
    GetPromptResult,
    Implementation,
    JSONRPCRequest,
    ListPromptsResult,
    ListResourcesResult,
    ListToolsResult,
    LoggingMessageNotification,
    Prompt,
    PromptReference,
    ReadResourceResult,
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
} from '@modelcontextprotocol/core';
import {
    assertCompleteRequestPrompt,
    assertCompleteRequestResourceTemplate,
    normalizeRawShapeSchema,
    promptArgumentsFromStandardSchema,
    ProtocolError,
    ProtocolErrorCode,
    standardSchemaToJsonSchema,
    UriTemplate,
    validateAndWarnToolName,
    validateStandardSchema
} from '@modelcontextprotocol/core';
import type * as z from 'zod/v4';

import { getCompleter, isCompletable } from './completable.js';
import type { ServerOptions } from './server.js';
import { Server } from './server.js';
import type { ScopeResolution } from './streamableHttp.js';
import { isScopeAware } from './streamableHttp.js';

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

    constructor(serverInfo: Implementation, options?: ServerOptions) {
        this.server = new Server(serverInfo, options);
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
        // Auto-wire scope resolver if the transport supports scope challenges.
        if (isScopeAware(transport)) {
            transport.setScopeResolver(request => this._resolveOperationScopes(request));
        }
        return await this.server.connect(transport);
    }

    /**
     * Closes the connection.
     */
    async close(): Promise<void> {
        await this.server.close();
    }

    /**
     * Routes an incoming JSON-RPC request to the correct scope resolver based
     * on its method. Returns a {@linkcode ScopeResolution} when the operation
     * has scope requirements, or `undefined` otherwise (the transport then
     * allows the request through).
     */
    private async _resolveOperationScopes(request: JSONRPCRequest): Promise<ScopeResolution | undefined> {
        const params = request.params as Record<string, unknown> | undefined;
        switch (request.method) {
            case 'tools/call': {
                const name = typeof params?.name === 'string' ? params.name : undefined;
                if (!name) return undefined;
                const scopes = this.getToolScopes(name);
                return scopes ? { operationName: `tool:${name}`, scopes } : undefined;
            }
            case 'resources/read': {
                const uri = typeof params?.uri === 'string' ? params.uri : undefined;
                if (!uri) return undefined;
                const scopes = await this.getResourceScopes(uri);
                return scopes ? { operationName: `resource:${uri}`, scopes } : undefined;
            }
            case 'prompts/get': {
                const name = typeof params?.name === 'string' ? params.name : undefined;
                if (!name) return undefined;
                const scopes = this.getPromptScopes(name);
                return scopes ? { operationName: `prompt:${name}`, scopes } : undefined;
            }
            case 'completion/complete': {
                const ref = params?.ref as { type?: string; name?: string; uri?: string } | undefined;
                const argument = params?.argument as { name?: string } | undefined;
                if (!ref || !argument?.name) return undefined;
                const refKey = completionRefKey(ref);
                if (!refKey) return undefined;
                const scopes = this.getCompletionScopes(ref, argument.name);
                return scopes ? { operationName: `completion:${refKey}/${argument.name}`, scopes } : undefined;
            }
            default: {
                return undefined;
            }
        }
    }

    /**
     * Returns the scope configuration for a registered tool, if any.
     * Checks tool-level scopes first, then falls back to server-level scope overrides.
     * Used by the transport layer for pre-execution scope challenge checks.
     */
    getToolScopes(toolName: string): ToolScopeConfig | undefined {
        return this._toolScopeOverrides[toolName] ?? this._registeredTools[toolName]?.scopes;
    }

    private _toolScopeOverrides: { [name: string]: ToolScopeConfig } = {};

    /**
     * Sets scope requirements for a tool independently of tool registration.
     *
     * This allows defining scopes separately — from a config file, a central
     * mapping, or dynamically at runtime — rather than co-locating them with
     * the tool definition. Scopes set here take precedence over any `scopes`
     * provided during tool registration.
     *
     * @example Central scope mapping
     * ```typescript
     * // Define all scopes in one place
     * const TOOL_SCOPES: Record<string, string[]> = {
     *     'get_repo': ['repo:read'],
     *     'create_issue': ['repo:write'],
     *     'list_orgs': ['read:org'],
     * };
     *
     * for (const [tool, scopes] of Object.entries(TOOL_SCOPES)) {
     *     server.setToolScopes(tool, scopes);
     * }
     * ```
     *
     * @example With scope hierarchy
     * ```typescript
     * server.setToolScopes('get_repo', {
     *     required: ['public_repo'],
     *     accepted: ['public_repo', 'repo'],
     * });
     * ```
     */
    setToolScopes(toolName: string, scopes: string[] | ToolScopeConfig): void {
        this._toolScopeOverrides[toolName] = Array.isArray(scopes) ? { required: scopes } : scopes;
    }

    private _promptScopeOverrides: { [name: string]: ToolScopeConfig } = {};
    private _resourceScopeOverrides: { [uri: string]: ResourceScopeConfig } = {};
    private _completionScopeOverrides: { [refKey: string]: { [argumentName: string]: ToolScopeConfig } } = {};

    /**
     * Returns the scope configuration for a registered prompt, if any.
     * Checks server-level overrides first, then prompt-level scopes set at
     * registration time. Used by the transport for pre-execution scope checks
     * on `prompts/get` requests.
     */
    getPromptScopes(promptName: string): ToolScopeConfig | undefined {
        return this._promptScopeOverrides[promptName] ?? this._registeredPrompts[promptName]?.scopes;
    }

    /**
     * Sets scope requirements for a prompt independently of registration.
     * Mirrors {@linkcode setToolScopes} for `prompts/get`.
     */
    setPromptScopes(promptName: string, scopes: string[] | ToolScopeConfig): void {
        this._promptScopeOverrides[promptName] = Array.isArray(scopes) ? { required: scopes } : scopes;
    }

    /**
     * Returns the scope configuration for a resource URI, if any. Checks (in
     * order): server-level exact-URI override; the static resource registered
     * at exactly this URI; each registered resource template whose URI
     * template matches the URI, calling its dynamic scope function if
     * configured.
     *
     * For dynamic template-scope functions the call is `await`ed, so this
     * method returns a Promise.
     */
    async getResourceScopes(uri: string): Promise<ToolScopeConfig | undefined> {
        const override = this._resourceScopeOverrides[uri];
        if (override !== undefined) {
            return resolveResourceScopeConfig(override, uri, {});
        }

        const exact = this._registeredResources[uri];
        if (exact?.scopes !== undefined) {
            return resolveResourceScopeConfig(exact.scopes, uri, {});
        }

        for (const [name, registered] of Object.entries(this._registeredResourceTemplates)) {
            if (!registered.scopes) continue;
            const variables = registered.resourceTemplate.uriTemplate.match(uri);
            if (variables === null) continue;
            const templateOverride = this._resourceScopeOverrides[name];
            const config = templateOverride ?? registered.scopes;
            return resolveResourceScopeConfig(config, uri, variables);
        }

        return undefined;
    }

    /**
     * Sets scope requirements for a resource. Pass an exact URI for static
     * resources or the template `name` for templated resources; overrides take
     * precedence over scopes set at registration time.
     *
     * The scopes value can be a plain array, a {@linkcode ToolScopeConfig},
     * or a function that receives the concrete URI and matched template
     * variables and returns scopes at request time (useful when the required
     * scope depends on path parameters, e.g. public vs private repositories).
     */
    setResourceScopes(uriOrTemplateName: string, scopes: ResourceScopeConfig): void {
        this._resourceScopeOverrides[uriOrTemplateName] = scopes;
    }

    /**
     * Returns the scope configuration for a completion request, if any.
     * Looks up by reference (prompt name or resource URI template) and
     * argument name, falling back to a `'*'` wildcard entry that applies to
     * any argument of that reference.
     */
    getCompletionScopes(
        ref: PromptReference | ResourceTemplateReference | { type?: string; name?: string; uri?: string },
        argumentName: string
    ): ToolScopeConfig | undefined {
        const refKey = completionRefKey(ref);
        if (!refKey) return undefined;
        const argMap = this._completionScopeOverrides[refKey];
        return argMap?.[argumentName] ?? argMap?.['*'];
    }

    /**
     * Sets scope requirements for completion argument suggestions. Completion
     * scopes are explicit and never inherited from the referenced prompt or
     * resource; if your search scope happens to equal the read scope, pass
     * the same scopes array to both calls.
     *
     * Pass `'*'` as `argumentName` to apply the same scopes to every argument
     * of the reference.
     */
    setCompletionScopes(ref: PromptReference | ResourceTemplateReference, argumentName: string, scopes: string[] | ToolScopeConfig): void {
        const refKey = completionRefKey(ref);
        if (!refKey) {
            throw new Error('Invalid completion reference; expected ref/prompt or ref/resource');
        }
        const normalized = Array.isArray(scopes) ? { required: scopes } : scopes;
        const argMap = this._completionScopeOverrides[refKey] ?? {};
        argMap[argumentName] = normalized;
        this._completionScopeOverrides[refKey] = argMap;
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
                                ? (standardSchemaToJsonSchema(tool.inputSchema, 'input') as Tool['inputSchema'])
                                : EMPTY_OBJECT_JSON_SCHEMA,
                            annotations: tool.annotations,
                            execution: tool.execution,
                            _meta: tool._meta
                        };

                        if (tool.outputSchema) {
                            toolDefinition.outputSchema = standardSchemaToJsonSchema(tool.outputSchema, 'output') as Tool['outputSchema'];
                        }

                        return toolDefinition;
                    })
            })
        );

        this.server.setRequestHandler('tools/call', async (request, ctx): Promise<CallToolResult> => {
            const tool = this._registeredTools[request.params.name];
            if (!tool) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
            }
            if (!tool.enabled) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${request.params.name} disabled`);
            }

            try {
                const args = await this.validateToolInput(tool, request.params.arguments, request.params.name);
                const result = await this.executeToolHandler(tool, args, ctx);
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
    private async validateToolOutput(tool: RegisteredTool, result: CallToolResult, toolName: string): Promise<void> {
        if (!tool.outputSchema) {
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
    private async executeToolHandler(tool: RegisteredTool, args: unknown, ctx: ServerContext): Promise<CallToolResult> {
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

            throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, `Resource ${uri} not found`);
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
                            arguments: prompt.argsSchema ? promptArgumentsFromStandardSchema(prompt.argsSchema) : undefined,
                            _meta: prompt._meta
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
        config: ResourceMetadata & { scopes?: ResourceScopeConfig },
        readCallback: ReadResourceCallback
    ): RegisteredResource;
    registerResource(
        name: string,
        uriOrTemplate: ResourceTemplate,
        config: ResourceMetadata & { scopes?: ResourceScopeConfig },
        readCallback: ReadResourceTemplateCallback
    ): RegisteredResourceTemplate;
    registerResource(
        name: string,
        uriOrTemplate: string | ResourceTemplate,
        config: ResourceMetadata & { scopes?: ResourceScopeConfig },
        readCallback: ReadResourceCallback | ReadResourceTemplateCallback
    ): RegisteredResource | RegisteredResourceTemplate {
        const { scopes, ...metadata } = config;
        if (typeof uriOrTemplate === 'string') {
            if (this._registeredResources[uriOrTemplate]) {
                throw new Error(`Resource ${uriOrTemplate} is already registered`);
            }

            const registeredResource = this._createRegisteredResource(
                name,
                (metadata as BaseMetadata).title,
                uriOrTemplate,
                metadata,
                readCallback as ReadResourceCallback,
                scopes
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
                (metadata as BaseMetadata).title,
                uriOrTemplate,
                metadata,
                readCallback as ReadResourceTemplateCallback,
                scopes
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
        readCallback: ReadResourceCallback,
        scopes?: ResourceScopeConfig
    ): RegisteredResource {
        const registeredResource: RegisteredResource = {
            name,
            title,
            metadata,
            readCallback,
            scopes,
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
        readCallback: ReadResourceTemplateCallback,
        scopes?: ResourceScopeConfig
    ): RegisteredResourceTemplate {
        const registeredResourceTemplate: RegisteredResourceTemplate = {
            resourceTemplate: template,
            title,
            metadata,
            readCallback,
            scopes,
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
        _meta: Record<string, unknown> | undefined
    ): RegisteredPrompt {
        // Track current schema and callback for handler regeneration
        let currentArgsSchema = argsSchema;
        let currentCallback = callback;

        const registeredPrompt: RegisteredPrompt = {
            title,
            description,
            argsSchema,
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
        inputSchema: StandardSchemaWithJSON | undefined,
        outputSchema: StandardSchemaWithJSON | undefined,
        annotations: ToolAnnotations | undefined,
        execution: ToolExecution | undefined,
        _meta: Record<string, unknown> | undefined,
        handler: AnyToolHandler<StandardSchemaWithJSON | undefined>
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
                    currentHandler = updates.callback as AnyToolHandler<StandardSchemaWithJSON | undefined>;
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
            /**
             * OAuth scopes required for this tool.
             *
             * When provided alongside a `ScopeChallengeConfig` on the transport,
             * the transport checks the client's token scopes before executing the tool.
             * If the token lacks required scopes, the transport returns HTTP 403 with a
             * `WWW-Authenticate` header, triggering the client's step-up authorization flow.
             *
             * Can be a simple array of required scope strings, or an object with `required`
             * and optional `accepted` arrays (for scope hierarchy support).
             *
             * @example Simple scopes
             * ```typescript
             * server.registerTool('get_repo', {
             *     description: 'Get repository details',
             *     scopes: ['repo:read'],
             * }, handler);
             * ```
             *
             * @example With scope hierarchy
             * ```typescript
             * server.registerTool('get_repo', {
             *     description: 'Get repository details',
             *     scopes: { required: ['public_repo'], accepted: ['public_repo', 'repo'] },
             * }, handler);
             * ```
             */
            scopes?: string[] | ToolScopeConfig;
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
            scopes?: string[] | ToolScopeConfig;
            _meta?: Record<string, unknown>;
        },
        cb: ToolCallback<StandardSchemaWithJSON | undefined> | LegacyToolCallback<ZodRawShape>
    ): RegisteredTool {
        if (this._registeredTools[name]) {
            throw new Error(`Tool ${name} is already registered`);
        }

        const { title, description, inputSchema, outputSchema, annotations, scopes, _meta } = config;

        const tool = this._createRegisteredTool(
            name,
            title,
            description,
            normalizeRawShapeSchema(inputSchema),
            normalizeRawShapeSchema(outputSchema),
            annotations,
            undefined,
            _meta,
            cb as ToolCallback<StandardSchemaWithJSON | undefined>
        );

        // Normalize and attach scope metadata
        if (scopes) {
            tool.scopes = Array.isArray(scopes) ? { required: scopes } : scopes;
        }

        return tool;
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
            scopes?: string[] | ToolScopeConfig;
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
            scopes?: string[] | ToolScopeConfig;
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
            scopes?: string[] | ToolScopeConfig;
            _meta?: Record<string, unknown>;
        },
        cb: PromptCallback<StandardSchemaWithJSON> | LegacyPromptCallback<ZodRawShape>
    ): RegisteredPrompt {
        if (this._registeredPrompts[name]) {
            throw new Error(`Prompt ${name} is already registered`);
        }

        const { title, description, argsSchema, scopes, _meta } = config;

        const registeredPrompt = this._createRegisteredPrompt(
            name,
            title,
            description,
            normalizeRawShapeSchema(argsSchema),
            cb as PromptCallback<StandardSchemaWithJSON | undefined>,
            _meta
        );

        if (scopes) {
            registeredPrompt.scopes = Array.isArray(scopes) ? { required: scopes } : scopes;
        }

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
    ? (args: InferRawShape<Args>, ctx: ServerContext) => CallToolResult | Promise<CallToolResult>
    : (ctx: ServerContext) => CallToolResult | Promise<CallToolResult>;

/** {@linkcode PromptCallback} variant used when `argsSchema` is a {@linkcode ZodRawShape}. */
export type LegacyPromptCallback<Args extends ZodRawShape | undefined> = Args extends ZodRawShape
    ? (args: InferRawShape<Args>, ctx: ServerContext) => GetPromptResult | Promise<GetPromptResult>
    : (ctx: ServerContext) => GetPromptResult | Promise<GetPromptResult>;

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
    CallToolResult,
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
type ToolExecutor = (args: unknown, ctx: ServerContext) => Promise<CallToolResult>;

export type RegisteredTool = {
    title?: string;
    description?: string;
    inputSchema?: StandardSchemaWithJSON;
    outputSchema?: StandardSchemaWithJSON;
    annotations?: ToolAnnotations;
    execution?: ToolExecution;
    scopes?: ToolScopeConfig;
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

/**
 * Scope metadata for a tool, used for pre-execution scope challenge checks.
 *
 * When configured alongside a `ScopeChallengeConfig` on the transport,
 * the transport will check the client's token scopes against these requirements
 * before executing the tool. If the token lacks the required scopes, the transport
 * returns HTTP 403 with a `WWW-Authenticate` header per RFC 6750 §3.1.
 */
export interface ToolScopeConfig {
    /**
     * Scopes required for this operation, with **AND** semantics: the token
     * must contain every scope in this array for the call to proceed (unless
     * `accepted` is provided, see below). These are the scopes advertised in
     * the 403 `WWW-Authenticate` challenge's `scope` parameter when the token
     * is insufficient.
     *
     * @example Single scope
     * ```typescript
     * { required: ['repo:read'] }
     * ```
     *
     * @example Multiple scopes (all must be present)
     * ```typescript
     * { required: ['repo:read', 'user:read'] }
     * ```
     */
    required: string[];
    /**
     * Optional **OR** escape hatch for the satisfaction check. When provided,
     * the satisfaction check switches from "token has all `required`" to
     * "token has ANY of `accepted`". Use this for scope hierarchies where a
     * broader scope subsumes a narrower one.
     *
     * Note: `accepted` only affects whether the request is allowed through.
     * The scope challenge advertised on a 403 is still based on `required`.
     *
     * @example Hierarchy: `repo` (broad) satisfies `repo:read` (narrow)
     * ```typescript
     * { required: ['repo:read'], accepted: ['repo:read', 'repo'] }
     * ```
     */
    accepted?: string[];
}

/**
 * Dynamic resolver for resource scopes. Receives the concrete URI being read
 * and any variables matched against the template, and returns the scope
 * requirements at request time. Returning `undefined` means the request has
 * no scope requirement and is allowed through.
 *
 * Useful when the required scope depends on path parameters (for example,
 * `public_repo` for public repositories and `repo` for private ones).
 */
export type ResourceScopeFn = (
    uri: string,
    variables: Variables
) => string[] | ToolScopeConfig | Promise<string[] | ToolScopeConfig | undefined> | undefined;

/**
 * Scope configuration accepted by `registerResource` and `setResourceScopes`.
 * Either static scopes or a {@linkcode ResourceScopeFn} for per-request
 * dynamic resolution.
 */
export type ResourceScopeConfig = string[] | ToolScopeConfig | ResourceScopeFn;

/**
 * Computes a stable key for a {@linkcode PromptReference} or
 * {@linkcode ResourceTemplateReference} for use in scope override maps.
 */
function completionRefKey(ref: { type?: string; name?: string; uri?: string }): string | undefined {
    if (ref.type === 'ref/prompt' && typeof ref.name === 'string') {
        return `prompt:${ref.name}`;
    }
    if (ref.type === 'ref/resource' && typeof ref.uri === 'string') {
        return `resource:${ref.uri}`;
    }
    return undefined;
}

/**
 * Normalises a {@linkcode ResourceScopeConfig} into a {@linkcode ToolScopeConfig},
 * resolving dynamic functions and `string[]` shorthand.
 */
async function resolveResourceScopeConfig(
    config: ResourceScopeConfig,
    uri: string,
    variables: Variables
): Promise<ToolScopeConfig | undefined> {
    const resolved: string[] | ToolScopeConfig | undefined = typeof config === 'function' ? await config(uri, variables) : config;
    if (!resolved) return undefined;
    return Array.isArray(resolved) ? { required: resolved } : resolved;
}

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
    /**
     * OAuth scopes required to read this resource, used for pre-execution
     * scope challenge checks. See {@linkcode ResourceScopeConfig}.
     */
    scopes?: ResourceScopeConfig;
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
    /**
     * OAuth scopes required to read resources matching this template, used
     * for pre-execution scope challenge checks. See
     * {@linkcode ResourceScopeConfig}.
     */
    scopes?: ResourceScopeConfig;
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

/**
 * Internal handler type that encapsulates parsing and callback invocation.
 * This allows type-safe handling without runtime type assertions.
 */
type PromptHandler = (args: Record<string, unknown> | undefined, ctx: ServerContext) => Promise<GetPromptResult>;

type ToolCallbackInternal = (args: unknown, ctx: ServerContext) => CallToolResult | Promise<CallToolResult>;

export type RegisteredPrompt = {
    title?: string;
    description?: string;
    argsSchema?: StandardSchemaWithJSON;
    _meta?: Record<string, unknown>;
    /**
     * OAuth scopes required to get this prompt, used for pre-execution scope
     * challenge checks on `prompts/get`.
     */
    scopes?: ToolScopeConfig;
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

/**
 * Creates a type-safe prompt handler that captures the schema and callback in a closure.
 * This eliminates the need for type assertions at the call site.
 */
function createPromptHandler(
    name: string,
    argsSchema: StandardSchemaWithJSON | undefined,
    callback: PromptCallback<StandardSchemaWithJSON | undefined>
): PromptHandler {
    if (argsSchema) {
        const typedCallback = callback as (args: unknown, ctx: ServerContext) => GetPromptResult | Promise<GetPromptResult>;

        return async (args, ctx) => {
            const parseResult = await validateStandardSchema(argsSchema, args);
            if (!parseResult.success) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid arguments for prompt ${name}: ${parseResult.error}`);
            }
            return typedCallback(parseResult.data, ctx);
        };
    } else {
        const typedCallback = callback as (ctx: ServerContext) => GetPromptResult | Promise<GetPromptResult>;

        return async (_args, ctx) => {
            return typedCallback(ctx);
        };
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
