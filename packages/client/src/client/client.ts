import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/client/_shims';
import type {
    BaseContext,
    CallToolRequest,
    CallToolResult,
    ClientCapabilities,
    ClientContext,
    ClientNotification,
    ClientRequest,
    CompleteRequest,
    CompleteResult,
    CreateMessageRequest,
    ElicitRequest,
    ElicitResult,
    EmptyResult,
    GetPromptRequest,
    GetPromptResult,
    Implementation,
    JSONRPCRequest,
    JsonSchemaType,
    JsonSchemaValidator,
    jsonSchemaValidator,
    ListChangedHandlers,
    ListChangedOptions,
    ListPromptsRequest,
    ListPromptsResult,
    ListResourcesRequest,
    ListResourcesResult,
    ListResourceTemplatesRequest,
    ListResourceTemplatesResult,
    ListToolsRequest,
    ListToolsResult,
    LoggingLevel,
    MessageExtraInfo,
    NotificationMethod,
    ProtocolOptions,
    ReadResourceRequest,
    ReadResourceResult,
    RequestMethod,
    RequestOptions,
    Result,
    ServerCapabilities,
    SubscribeRequest,
    Tool,
    Transport,
    UnsubscribeRequest
} from '@modelcontextprotocol/core';
import {
    bindWireVersion,
    codecForContext,
    LATEST_PROTOCOL_VERSION,
    ListChangedOptionsBaseSchema,
    mergeCapabilities,
    parseSchema,
    Protocol,
    ProtocolError,
    ProtocolErrorCode,
    SdkError,
    SdkErrorCode,
    unbindWireVersion
} from '@modelcontextprotocol/core';

/**
 * Elicitation default application helper. Applies defaults to the `data` based on the `schema`.
 *
 * @param schema - The schema to apply defaults to.
 * @param data - The data to apply defaults to.
 */
function applyElicitationDefaults(schema: JsonSchemaType | undefined, data: unknown): void {
    if (!schema || data === null || typeof data !== 'object') return;

    // Handle object properties
    if (schema.type === 'object' && schema.properties && typeof schema.properties === 'object') {
        const obj = data as Record<string, unknown>;
        const props = schema.properties as Record<string, JsonSchemaType & { default?: unknown }>;
        for (const key of Object.keys(props)) {
            const propSchema = props[key]!;
            // If missing or explicitly undefined, apply default if present
            if (obj[key] === undefined && Object.prototype.hasOwnProperty.call(propSchema, 'default')) {
                obj[key] = propSchema.default;
            }
            // Recurse into existing nested objects/arrays
            if (obj[key] !== undefined) {
                applyElicitationDefaults(propSchema, obj[key]);
            }
        }
    }

    if (Array.isArray(schema.anyOf)) {
        for (const sub of schema.anyOf) {
            // Skip boolean schemas (true/false are valid JSON Schemas but have no defaults)
            if (typeof sub !== 'boolean') {
                applyElicitationDefaults(sub, data);
            }
        }
    }

    // Combine schemas
    if (Array.isArray(schema.oneOf)) {
        for (const sub of schema.oneOf) {
            // Skip boolean schemas (true/false are valid JSON Schemas but have no defaults)
            if (typeof sub !== 'boolean') {
                applyElicitationDefaults(sub, data);
            }
        }
    }
}

/**
 * Determines which elicitation modes are supported based on declared client capabilities.
 *
 * According to the spec:
 * - An empty elicitation capability object defaults to form mode support (backwards compatibility)
 * - URL mode is only supported if explicitly declared
 *
 * @param capabilities - The client's elicitation capabilities
 * @returns An object indicating which modes are supported
 */
export function getSupportedElicitationModes(capabilities: ClientCapabilities['elicitation']): {
    supportsFormMode: boolean;
    supportsUrlMode: boolean;
} {
    if (!capabilities) {
        return { supportsFormMode: false, supportsUrlMode: false };
    }

    const hasFormCapability = capabilities.form !== undefined;
    const hasUrlCapability = capabilities.url !== undefined;

    // If neither form nor url are explicitly declared, form mode is supported (backwards compatibility)
    const supportsFormMode = hasFormCapability || (!hasFormCapability && !hasUrlCapability);
    const supportsUrlMode = hasUrlCapability;

    return { supportsFormMode, supportsUrlMode };
}

export type ClientOptions = ProtocolOptions & {
    /**
     * Capabilities to advertise as being supported by this client.
     */
    capabilities?: ClientCapabilities;

    /**
     * JSON Schema validator for tool output validation.
     *
     * The validator is used to validate structured content returned by tools
     * against their declared output schemas.
     *
     * @default Runtime-selected validator (AJV-backed on Node.js, `@cfworker/json-schema`-backed on browser/workerd runtimes)
     */
    jsonSchemaValidator?: jsonSchemaValidator;

    /**
     * Configure handlers for list changed notifications (tools, prompts, resources).
     *
     * @example
     * ```ts source="./client.examples.ts#ClientOptions_listChanged"
     * const client = new Client(
     *     { name: 'my-client', version: '1.0.0' },
     *     {
     *         listChanged: {
     *             tools: {
     *                 onChanged: (error, tools) => {
     *                     if (error) {
     *                         console.error('Failed to refresh tools:', error);
     *                         return;
     *                     }
     *                     console.log('Tools updated:', tools);
     *                 }
     *             },
     *             prompts: {
     *                 onChanged: (error, prompts) => console.log('Prompts updated:', prompts)
     *             }
     *         }
     *     }
     * );
     * ```
     */
    listChanged?: ListChangedHandlers;
};

/**
 * An MCP client on top of a pluggable transport.
 *
 * The client will automatically begin the initialization flow with the server when {@linkcode connect} is called.
 *
 * To handle server-initiated requests (sampling, elicitation, roots), call {@linkcode setRequestHandler}.
 * The client must declare the corresponding capability for the handler to be accepted. For
 * `sampling/createMessage` and `elicitation/create`, the handler is automatically wrapped with
 * schema validation for both the incoming request and the returned result.
 *
 * @example Handling a sampling request
 * ```ts source="./client.examples.ts#Client_setRequestHandler_sampling"
 * client.setRequestHandler('sampling/createMessage', async request => {
 *     const lastMessage = request.params.messages.at(-1);
 *     console.log('Sampling request:', lastMessage);
 *
 *     // In production, send messages to your LLM here
 *     return {
 *         model: 'my-model',
 *         role: 'assistant' as const,
 *         content: {
 *             type: 'text' as const,
 *             text: 'Response from the model'
 *         }
 *     };
 * });
 * ```
 */
export class Client extends Protocol<ClientContext> {
    private _serverCapabilities?: ServerCapabilities;
    private _serverVersion?: Implementation;
    private _negotiatedProtocolVersion?: string;
    private _capabilities: ClientCapabilities;
    private _instructions?: string;
    private _jsonSchemaValidator: jsonSchemaValidator;
    private _cachedToolOutputValidators: Map<string, JsonSchemaValidator<unknown>> = new Map();
    private _listChangedDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private _pendingListChangedConfig?: ListChangedHandlers;
    private _enforceStrictCapabilities: boolean;

    /**
     * Initializes this client with the given name and version information.
     */
    constructor(
        private _clientInfo: Implementation,
        options?: ClientOptions
    ) {
        super(options);
        this._capabilities = options?.capabilities ? { ...options.capabilities } : {};
        this._jsonSchemaValidator = options?.jsonSchemaValidator ?? new DefaultJsonSchemaValidator();
        this._enforceStrictCapabilities = options?.enforceStrictCapabilities ?? false;

        // Store list changed config for setup after connection (when we know server capabilities)
        if (options?.listChanged) {
            this._pendingListChangedConfig = options.listChanged;
        }
    }

    protected override buildContext(ctx: BaseContext, _transportInfo?: MessageExtraInfo): ClientContext {
        return ctx;
    }

    /**
     * Set up handlers for list changed notifications based on config and server capabilities.
     * This should only be called after initialization when server capabilities are known.
     * Handlers are silently skipped if the server doesn't advertise the corresponding listChanged capability.
     * @internal
     */
    private _setupListChangedHandlers(config: ListChangedHandlers): void {
        if (config.tools && this._serverCapabilities?.tools?.listChanged) {
            this._setupListChangedHandler('tools', 'notifications/tools/list_changed', config.tools, async () => {
                const result = await this.listTools();
                return result.tools;
            });
        }

        if (config.prompts && this._serverCapabilities?.prompts?.listChanged) {
            this._setupListChangedHandler('prompts', 'notifications/prompts/list_changed', config.prompts, async () => {
                const result = await this.listPrompts();
                return result.prompts;
            });
        }

        if (config.resources && this._serverCapabilities?.resources?.listChanged) {
            this._setupListChangedHandler('resources', 'notifications/resources/list_changed', config.resources, async () => {
                const result = await this.listResources();
                return result.resources;
            });
        }
    }

    /**
     * Registers new capabilities. This can only be called before connecting to a transport.
     *
     * The new capabilities will be merged with any existing capabilities previously given (e.g., at initialization).
     */
    public registerCapabilities(capabilities: ClientCapabilities): void {
        if (this.transport) {
            throw new Error('Cannot register capabilities after connecting to transport');
        }

        this._capabilities = mergeCapabilities(this._capabilities, capabilities);
    }

    /**
     * Enforces client-side validation for `elicitation/create` and `sampling/createMessage`
     * regardless of how the handler was registered.
     */
    protected override _wrapHandler(
        method: string,
        handler: (request: JSONRPCRequest, ctx: ClientContext) => Promise<Result>
    ): (request: JSONRPCRequest, ctx: ClientContext) => Promise<Result> {
        if (method === 'elicitation/create') {
            return async (request, ctx) => {
                // Era-exact validation: the schemas are resolved from the
                // request's codec at dispatch time (the era gate guarantees
                // the method exists on the serving era before we get here).
                const codec = codecForContext(ctx);
                const elicitRequestSchema = codec.requestSchema('elicitation/create');
                // The era registry entry IS the plain ElicitResult schema
                // (the result map is aligned to the typed map — no widened
                // unions), so no narrower surface is needed.
                const elicitResultSchema = codec.resultSchema('elicitation/create');
                if (!elicitRequestSchema || !elicitResultSchema) {
                    throw new ProtocolError(ProtocolErrorCode.InternalError, 'No wire schema for elicitation/create in the resolved era');
                }
                const validatedRequest = parseSchema(elicitRequestSchema, request);
                if (!validatedRequest.success) {
                    // Type guard: if success is false, error is guaranteed to exist
                    const errorMessage =
                        validatedRequest.error instanceof Error ? validatedRequest.error.message : String(validatedRequest.error);
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid elicitation request: ${errorMessage}`);
                }

                const { params } = validatedRequest.data as ElicitRequest;
                params.mode = params.mode ?? 'form';
                const { supportsFormMode, supportsUrlMode } = getSupportedElicitationModes(this._capabilities.elicitation);

                if (params.mode === 'form' && !supportsFormMode) {
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Client does not support form-mode elicitation requests');
                }

                if (params.mode === 'url' && !supportsUrlMode) {
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Client does not support URL-mode elicitation requests');
                }

                const result = await handler(request, ctx);

                const validationResult = parseSchema(elicitResultSchema, result);
                if (!validationResult.success) {
                    // Type guard: if success is false, error is guaranteed to exist
                    const errorMessage =
                        validationResult.error instanceof Error ? validationResult.error.message : String(validationResult.error);
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid elicitation result: ${errorMessage}`);
                }

                const validatedResult = validationResult.data as ElicitResult;
                const requestedSchema = params.mode === 'form' ? (params.requestedSchema as JsonSchemaType) : undefined;

                if (
                    params.mode === 'form' &&
                    validatedResult.action === 'accept' &&
                    validatedResult.content &&
                    requestedSchema &&
                    this._capabilities.elicitation?.form?.applyDefaults
                ) {
                    try {
                        applyElicitationDefaults(requestedSchema, validatedResult.content);
                    } catch {
                        // gracefully ignore errors in default application
                    }
                }

                return validatedResult;
            };
        }

        if (method === 'sampling/createMessage') {
            return async (request, ctx) => {
                // Era-exact validation via the request's codec (see above).
                const codec = codecForContext(ctx);
                const samplingRequestSchema = codec.requestSchema('sampling/createMessage');
                if (!samplingRequestSchema) {
                    throw new ProtocolError(
                        ProtocolErrorCode.InternalError,
                        'No wire schema for sampling/createMessage in the resolved era'
                    );
                }
                const validatedRequest = parseSchema(samplingRequestSchema, request);
                if (!validatedRequest.success) {
                    const errorMessage =
                        validatedRequest.error instanceof Error ? validatedRequest.error.message : String(validatedRequest.error);
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid sampling request: ${errorMessage}`);
                }

                const { params } = validatedRequest.data as CreateMessageRequest;

                const result = await handler(request, ctx);

                const hasTools = params.tools || params.toolChoice;
                const resultSchema = codec.narrowResultSchema(
                    hasTools ? 'sampling/createMessage:withTools' : 'sampling/createMessage:plain'
                );
                if (!resultSchema) {
                    throw new ProtocolError(
                        ProtocolErrorCode.InternalError,
                        'No wire schema for sampling/createMessage in the resolved era'
                    );
                }
                const validationResult = parseSchema(resultSchema, result);
                if (!validationResult.success) {
                    const errorMessage =
                        validationResult.error instanceof Error ? validationResult.error.message : String(validationResult.error);
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid sampling result: ${errorMessage}`);
                }

                return validationResult.data as Result;
            };
        }

        return handler;
    }

    protected assertCapability(capability: keyof ServerCapabilities, method: string): void {
        if (!this._serverCapabilities?.[capability]) {
            throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support ${capability} (required for ${method})`);
        }
    }

    /**
     * Connects to a server via the given transport and performs the MCP initialization handshake.
     *
     * @example Basic usage (stdio)
     * ```ts source="./client.examples.ts#Client_connect_stdio"
     * const client = new Client({ name: 'my-client', version: '1.0.0' });
     * const transport = new StdioClientTransport({ command: 'my-mcp-server' });
     * await client.connect(transport);
     * ```
     *
     * @example Streamable HTTP with SSE fallback
     * ```ts source="./client.examples.ts#Client_connect_sseFallback"
     * const baseUrl = new URL(url);
     *
     * try {
     *     // Try modern Streamable HTTP transport first
     *     const client = new Client({ name: 'my-client', version: '1.0.0' });
     *     const transport = new StreamableHTTPClientTransport(baseUrl);
     *     await client.connect(transport);
     *     return { client, transport };
     * } catch {
     *     // Fall back to legacy SSE transport
     *     const client = new Client({ name: 'my-client', version: '1.0.0' });
     *     const transport = new SSEClientTransport(baseUrl);
     *     await client.connect(transport);
     *     return { client, transport };
     * }
     * ```
     */
    override async connect(transport: Transport, options?: RequestOptions): Promise<void> {
        await super.connect(transport);
        // When transport sessionId is already set this means we are trying to reconnect.
        // Restore the protocol version negotiated during the original initialize handshake
        // so HTTP transports include the required mcp-protocol-version header, but skip re-init.
        if (transport.sessionId !== undefined) {
            if (this._negotiatedProtocolVersion !== undefined) {
                // Reconnection restores the original negotiation: re-bind the
                // wire codec alongside the transport header.
                bindWireVersion(this, this._negotiatedProtocolVersion);
                transport.setProtocolVersion?.(this._negotiatedProtocolVersion);
            }
            return;
        }
        // Fresh connect: a wire-era binding left over from a previous
        // connection is stale connection state — clear it so the initialize
        // handshake below rides the pre-negotiation bootstrap pin (legacy
        // era) instead of a dead session's era. Without this, an instance
        // that once negotiated a modern era could never re-run a fresh
        // handshake: `initialize` is physically absent from the modern
        // registry. (The resume branch above re-binds instead of clearing.)
        unbindWireVersion(this);
        try {
            const result = await this.request(
                {
                    method: 'initialize',
                    params: {
                        protocolVersion: this._supportedProtocolVersions[0] ?? LATEST_PROTOCOL_VERSION,
                        capabilities: this._capabilities,
                        clientInfo: this._clientInfo
                    }
                },
                options
            );

            if (result === undefined) {
                throw new Error(`Server sent invalid initialize result: ${result}`);
            }

            if (!this._supportedProtocolVersions.includes(result.protocolVersion)) {
                throw new Error(`Server's protocol version is not supported: ${result.protocolVersion}`);
            }

            this._serverCapabilities = result.capabilities;
            this._serverVersion = result.serverInfo;
            this._negotiatedProtocolVersion = result.protocolVersion;
            // The negotiated version selects the wire codec for everything
            // this connection sends/receives from here on (the negotiated
            // version cashes out as the negotiated wire ERA - Q1-SD1).
            bindWireVersion(this, result.protocolVersion);
            // HTTP transports must set the protocol version in each header after initialization.
            if (transport.setProtocolVersion) {
                transport.setProtocolVersion(result.protocolVersion);
            }

            this._instructions = result.instructions;

            await this.notification({
                method: 'notifications/initialized'
            });

            // Set up list changed handlers now that we know server capabilities
            if (this._pendingListChangedConfig) {
                this._setupListChangedHandlers(this._pendingListChangedConfig);
                this._pendingListChangedConfig = undefined;
            }
        } catch (error) {
            // Disconnect if initialization fails.
            void this.close();
            throw error;
        }
    }

    /**
     * After initialization has completed, this will be populated with the server's reported capabilities.
     */
    getServerCapabilities(): ServerCapabilities | undefined {
        return this._serverCapabilities;
    }

    /**
     * After initialization has completed, this will be populated with information about the server's name and version.
     */
    getServerVersion(): Implementation | undefined {
        return this._serverVersion;
    }

    /**
     * After initialization has completed, this will be populated with the protocol version negotiated
     * during the initialize handshake. When manually reconstructing a transport for reconnection, pass this
     * value to the new transport so it continues sending the required `mcp-protocol-version` header.
     */
    getNegotiatedProtocolVersion(): string | undefined {
        return this._negotiatedProtocolVersion;
    }

    /**
     * After initialization has completed, this may be populated with information about the server's instructions.
     */
    getInstructions(): string | undefined {
        return this._instructions;
    }

    protected assertCapabilityForMethod(method: RequestMethod | string): void {
        switch (method as ClientRequest['method']) {
            case 'logging/setLevel': {
                if (!this._serverCapabilities?.logging) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support logging (required for ${method})`);
                }
                break;
            }

            case 'prompts/get':
            case 'prompts/list': {
                if (!this._serverCapabilities?.prompts) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support prompts (required for ${method})`);
                }
                break;
            }

            case 'resources/list':
            case 'resources/templates/list':
            case 'resources/read':
            case 'resources/subscribe':
            case 'resources/unsubscribe': {
                if (!this._serverCapabilities?.resources) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support resources (required for ${method})`);
                }

                if (method === 'resources/subscribe' && !this._serverCapabilities.resources.subscribe) {
                    throw new SdkError(
                        SdkErrorCode.CapabilityNotSupported,
                        `Server does not support resource subscriptions (required for ${method})`
                    );
                }

                break;
            }

            case 'tools/call':
            case 'tools/list': {
                if (!this._serverCapabilities?.tools) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support tools (required for ${method})`);
                }
                break;
            }

            case 'completion/complete': {
                if (!this._serverCapabilities?.completions) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support completions (required for ${method})`);
                }
                break;
            }

            case 'initialize': {
                // No specific capability required for initialize
                break;
            }

            case 'ping': {
                // No specific capability required for ping
                break;
            }
        }
    }

    protected assertNotificationCapability(method: NotificationMethod | string): void {
        switch (method as ClientNotification['method']) {
            case 'notifications/roots/list_changed': {
                if (!this._capabilities.roots?.listChanged) {
                    throw new SdkError(
                        SdkErrorCode.CapabilityNotSupported,
                        `Client does not support roots list changed notifications (required for ${method})`
                    );
                }
                break;
            }

            case 'notifications/initialized': {
                // No specific capability required for initialized
                break;
            }

            case 'notifications/cancelled': {
                // Cancellation notifications are always allowed
                break;
            }

            case 'notifications/progress': {
                // Progress notifications are always allowed
                break;
            }
        }
    }

    protected assertRequestHandlerCapability(method: string): void {
        switch (method) {
            case 'sampling/createMessage': {
                if (!this._capabilities.sampling) {
                    throw new SdkError(
                        SdkErrorCode.CapabilityNotSupported,
                        `Client does not support sampling capability (required for ${method})`
                    );
                }
                break;
            }

            case 'elicitation/create': {
                if (!this._capabilities.elicitation) {
                    throw new SdkError(
                        SdkErrorCode.CapabilityNotSupported,
                        `Client does not support elicitation capability (required for ${method})`
                    );
                }
                break;
            }

            case 'roots/list': {
                if (!this._capabilities.roots) {
                    throw new SdkError(
                        SdkErrorCode.CapabilityNotSupported,
                        `Client does not support roots capability (required for ${method})`
                    );
                }
                break;
            }

            case 'ping': {
                // No specific capability required for ping
                break;
            }
        }
    }

    async ping(options?: RequestOptions): Promise<EmptyResult> {
        return this.request({ method: 'ping' }, options);
    }

    /** Requests argument autocompletion suggestions from the server for a prompt or resource. */
    async complete(params: CompleteRequest['params'], options?: RequestOptions): Promise<CompleteResult> {
        return this.request({ method: 'completion/complete', params }, options);
    }

    /** Sets the minimum severity level for log messages sent by the server. */
    async setLoggingLevel(level: LoggingLevel, options?: RequestOptions): Promise<EmptyResult> {
        return this.request({ method: 'logging/setLevel', params: { level } }, options);
    }

    /** Retrieves a prompt by name from the server, passing the given arguments for template substitution. */
    async getPrompt(params: GetPromptRequest['params'], options?: RequestOptions): Promise<GetPromptResult> {
        return this.request({ method: 'prompts/get', params }, options);
    }

    /**
     * Lists available prompts. Results may be paginated — loop on `nextCursor` to collect all pages.
     *
     * Returns an empty list if the server does not advertise prompts capability
     * (or throws if {@linkcode ClientOptions.enforceStrictCapabilities} is enabled).
     *
     * @example
     * ```ts source="./client.examples.ts#Client_listPrompts_pagination"
     * const allPrompts: Prompt[] = [];
     * let cursor: string | undefined;
     * do {
     *     const { prompts, nextCursor } = await client.listPrompts({ cursor });
     *     allPrompts.push(...prompts);
     *     cursor = nextCursor;
     * } while (cursor);
     * console.log(
     *     'Available prompts:',
     *     allPrompts.map(p => p.name)
     * );
     * ```
     */
    async listPrompts(params?: ListPromptsRequest['params'], options?: RequestOptions): Promise<ListPromptsResult> {
        if (!this._serverCapabilities?.prompts && !this._enforceStrictCapabilities) {
            // Respect capability negotiation: server does not support prompts
            console.debug('Client.listPrompts() called but server does not advertise prompts capability - returning empty list');
            return { prompts: [] };
        }
        return this.request({ method: 'prompts/list', params }, options);
    }

    /**
     * Lists available resources. Results may be paginated — loop on `nextCursor` to collect all pages.
     *
     * Returns an empty list if the server does not advertise resources capability
     * (or throws if {@linkcode ClientOptions.enforceStrictCapabilities} is enabled).
     *
     * @example
     * ```ts source="./client.examples.ts#Client_listResources_pagination"
     * const allResources: Resource[] = [];
     * let cursor: string | undefined;
     * do {
     *     const { resources, nextCursor } = await client.listResources({ cursor });
     *     allResources.push(...resources);
     *     cursor = nextCursor;
     * } while (cursor);
     * console.log(
     *     'Available resources:',
     *     allResources.map(r => r.name)
     * );
     * ```
     */
    async listResources(params?: ListResourcesRequest['params'], options?: RequestOptions): Promise<ListResourcesResult> {
        if (!this._serverCapabilities?.resources && !this._enforceStrictCapabilities) {
            // Respect capability negotiation: server does not support resources
            console.debug('Client.listResources() called but server does not advertise resources capability - returning empty list');
            return { resources: [] };
        }
        return this.request({ method: 'resources/list', params }, options);
    }

    /**
     * Lists available resource URI templates for dynamic resources. Results may be paginated — see {@linkcode listResources | listResources()} for the cursor pattern.
     *
     * Returns an empty list if the server does not advertise resources capability
     * (or throws if {@linkcode ClientOptions.enforceStrictCapabilities} is enabled).
     */
    async listResourceTemplates(
        params?: ListResourceTemplatesRequest['params'],
        options?: RequestOptions
    ): Promise<ListResourceTemplatesResult> {
        if (!this._serverCapabilities?.resources && !this._enforceStrictCapabilities) {
            // Respect capability negotiation: server does not support resources
            console.debug(
                'Client.listResourceTemplates() called but server does not advertise resources capability - returning empty list'
            );
            return { resourceTemplates: [] };
        }
        return this.request({ method: 'resources/templates/list', params }, options);
    }

    /** Reads the contents of a resource by URI. */
    async readResource(params: ReadResourceRequest['params'], options?: RequestOptions): Promise<ReadResourceResult> {
        return this.request({ method: 'resources/read', params }, options);
    }

    /** Subscribes to change notifications for a resource. The server must support resource subscriptions. */
    async subscribeResource(params: SubscribeRequest['params'], options?: RequestOptions): Promise<EmptyResult> {
        return this.request({ method: 'resources/subscribe', params }, options);
    }

    /** Unsubscribes from change notifications for a resource. */
    async unsubscribeResource(params: UnsubscribeRequest['params'], options?: RequestOptions): Promise<EmptyResult> {
        return this.request({ method: 'resources/unsubscribe', params }, options);
    }

    /**
     * Calls a tool on the connected server and returns the result. Automatically validates structured output
     * if the tool has an `outputSchema`.
     *
     * Tool results have two error surfaces: `result.isError` for tool-level failures (the tool ran but reported
     * a problem), and thrown {@linkcode ProtocolError} for protocol-level failures or {@linkcode SdkError} for
     * SDK-level issues (timeouts, missing capabilities).
     *
     * @example Basic usage
     * ```ts source="./client.examples.ts#Client_callTool_basic"
     * const result = await client.callTool({
     *     name: 'calculate-bmi',
     *     arguments: { weightKg: 70, heightM: 1.75 }
     * });
     *
     * // Tool-level errors are returned in the result, not thrown
     * if (result.isError) {
     *     console.error('Tool error:', result.content);
     *     return;
     * }
     *
     * console.log(result.content);
     * ```
     *
     * @example Structured output
     * ```ts source="./client.examples.ts#Client_callTool_structuredOutput"
     * const result = await client.callTool({
     *     name: 'calculate-bmi',
     *     arguments: { weightKg: 70, heightM: 1.75 }
     * });
     *
     * // Machine-readable output for the client application
     * if (result.structuredContent) {
     *     console.log(result.structuredContent); // e.g. { bmi: 22.86 }
     * }
     * ```
     */
    async callTool(params: CallToolRequest['params'], options?: RequestOptions): Promise<CallToolResult> {
        // The method-keyed request() path validates the era registry's plain
        // CallToolResult schema — with the result map aligned to the typed
        // map there is no wider union to narrow away (Q1-SD2 holds by
        // construction).
        const result = await this.request({ method: 'tools/call', params }, options);

        // Check if the tool has an outputSchema
        const validator = this.getToolOutputValidator(params.name);
        if (validator) {
            // If tool has outputSchema, it MUST return structuredContent (unless it's an error)
            if (!result.structuredContent && !result.isError) {
                throw new ProtocolError(
                    ProtocolErrorCode.InvalidRequest,
                    `Tool ${params.name} has an output schema but did not return structured content`
                );
            }

            // Only validate structured content if present (not when there's an error)
            if (result.structuredContent) {
                try {
                    // Validate the structured content against the schema
                    const validationResult = validator(result.structuredContent);

                    if (!validationResult.valid) {
                        throw new ProtocolError(
                            ProtocolErrorCode.InvalidParams,
                            `Structured content does not match the tool's output schema: ${validationResult.errorMessage}`
                        );
                    }
                } catch (error) {
                    if (error instanceof ProtocolError) {
                        throw error;
                    }
                    throw new ProtocolError(
                        ProtocolErrorCode.InvalidParams,
                        `Failed to validate structured content: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }
        }

        return result;
    }

    /**
     * Cache validators for tool output schemas.
     * Called after {@linkcode listTools | listTools()} to pre-compile validators for better performance.
     */
    private cacheToolMetadata(tools: Tool[]): void {
        this._cachedToolOutputValidators.clear();

        for (const tool of tools) {
            // If the tool has an outputSchema, create and cache the validator
            if (tool.outputSchema) {
                const toolValidator = this._jsonSchemaValidator.getValidator(tool.outputSchema as JsonSchemaType);
                this._cachedToolOutputValidators.set(tool.name, toolValidator);
            }
        }
    }

    /**
     * Get cached validator for a tool
     */
    private getToolOutputValidator(toolName: string): JsonSchemaValidator<unknown> | undefined {
        return this._cachedToolOutputValidators.get(toolName);
    }

    /**
     * Lists available tools. Results may be paginated — loop on `nextCursor` to collect all pages.
     *
     * Returns an empty list if the server does not advertise tools capability
     * (or throws if {@linkcode ClientOptions.enforceStrictCapabilities} is enabled).
     *
     * @example
     * ```ts source="./client.examples.ts#Client_listTools_pagination"
     * const allTools: Tool[] = [];
     * let cursor: string | undefined;
     * do {
     *     const { tools, nextCursor } = await client.listTools({ cursor });
     *     allTools.push(...tools);
     *     cursor = nextCursor;
     * } while (cursor);
     * console.log(
     *     'Available tools:',
     *     allTools.map(t => t.name)
     * );
     * ```
     */
    async listTools(params?: ListToolsRequest['params'], options?: RequestOptions): Promise<ListToolsResult> {
        if (!this._serverCapabilities?.tools && !this._enforceStrictCapabilities) {
            // Respect capability negotiation: server does not support tools
            console.debug('Client.listTools() called but server does not advertise tools capability - returning empty list');
            return { tools: [] };
        }
        const result = await this.request({ method: 'tools/list', params }, options);

        // Cache the tools and their output schemas for future validation
        this.cacheToolMetadata(result.tools);

        return result;
    }

    /**
     * Set up a single list changed handler.
     * @internal
     */
    private _setupListChangedHandler<T>(
        listType: string,
        notificationMethod: NotificationMethod,
        options: ListChangedOptions<T>,
        fetcher: () => Promise<T[]>
    ): void {
        // Validate options using Zod schema (validates autoRefresh and debounceMs)
        const parseResult = parseSchema(ListChangedOptionsBaseSchema, options);
        if (!parseResult.success) {
            throw new Error(`Invalid ${listType} listChanged options: ${parseResult.error.message}`);
        }

        // Validate callback
        if (typeof options.onChanged !== 'function') {
            throw new TypeError(`Invalid ${listType} listChanged options: onChanged must be a function`);
        }

        const { autoRefresh, debounceMs } = parseResult.data;
        const { onChanged } = options;

        const refresh = async () => {
            if (!autoRefresh) {
                onChanged(null, null);
                return;
            }

            try {
                const items = await fetcher();
                onChanged(null, items);
            } catch (error) {
                const newError = error instanceof Error ? error : new Error(String(error));
                onChanged(newError, null);
            }
        };

        const handler = () => {
            if (debounceMs) {
                // Clear any pending debounce timer for this list type
                const existingTimer = this._listChangedDebounceTimers.get(listType);
                if (existingTimer) {
                    clearTimeout(existingTimer);
                }

                // Set up debounced refresh
                const timer = setTimeout(refresh, debounceMs);
                this._listChangedDebounceTimers.set(listType, timer);
            } else {
                // No debounce, refresh immediately
                refresh();
            }
        };

        // Register notification handler
        this.setNotificationHandler(notificationMethod, handler);
    }

    /** Notifies the server that the client's root list has changed. Requires the `roots.listChanged` capability. */
    async sendRootsListChanged() {
        return this.notification({ method: 'notifications/roots/list_changed' });
    }
}
