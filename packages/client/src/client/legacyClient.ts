// eslint-disable-next-line @typescript-eslint/no-unused-vars -- referenced in `ClientOptions.jsonSchemaValidator` `@default` JSDoc
import type { DefaultJsonSchemaValidator } from '@modelcontextprotocol/client/_shims';
import type {
    BaseContext,
    ClientCapabilities,
    ClientContext,
    Implementation,
    JSONRPCErrorResponse,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResponse,
    JsonSchemaType,
    jsonSchemaValidator,
    ListChangedHandlers,
    ListChangedOptions,
    MessageExtraInfo,
    Middleware,
    NotificationMethod,
    ProtocolOptions,
    RequestMethod,
    RequestOptions,
    ServerCapabilities,
    SubscribeRequest,
    Transport,
    UnsubscribeRequest
} from '@modelcontextprotocol/core';
import {
    CreateMessageRequestSchema,
    CreateMessageResultSchema,
    CreateMessageResultWithToolsSchema,
    ElicitRequestSchema,
    ElicitResultSchema,
    EmptyResultSchema,
    InitializeResultSchema,
    LATEST_PROTOCOL_VERSION,
    ListChangedOptionsBaseSchema,
    mergeCapabilities,
    parseSchema,
    Protocol,
    ProtocolError,
    ProtocolErrorCode,
    SdkError,
    SdkErrorCode
} from '@modelcontextprotocol/core';

/**
 * Elicitation default application helper. Applies defaults to the `data` based on the `schema`.
 *
 * @param schema - The schema to apply defaults to.
 * @param data - The data to apply defaults to.
 */
export function applyElicitationDefaults(schema: JsonSchemaType | undefined, data: unknown): void {
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
     * @default {@linkcode DefaultJsonSchemaValidator} ({@linkcode index.AjvJsonSchemaValidator | AjvJsonSchemaValidator} on Node.js, `CfWorkerJsonSchemaValidator` on Cloudflare Workers)
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
export class LegacyClient extends Protocol<ClientContext> {
    private _serverCapabilities?: ServerCapabilities;
    private _serverVersion?: Implementation;
    private _negotiatedProtocolVersion?: string;
    private _capabilities: ClientCapabilities;
    private _instructions?: string;
    private _listChangedDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private _isStatelessConnection = false;

    /**
     * Initializes this client with the given name and version information.
     */
    constructor(
        private _clientInfo: Implementation,
        options?: ClientOptions
    ) {
        super(options);
        this._capabilities = options?.capabilities ? { ...options.capabilities } : {};

        this.dispatcher.use(this._validationMiddleware);
    }

    protected override buildContext(ctx: BaseContext, _transportInfo?: MessageExtraInfo): ClientContext {
        return ctx;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // internal — exposed for the composing Client (client.ts)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @internal Routes a request through this instance's `Dispatcher`.
     * Called by the composing `Client`'s MRTR resume loop so the same registry
     * + `_validationMiddleware` apply to MRTR input requests.
     */
    _dispatch(request: JSONRPCRequest, ctx: ClientContext): Promise<JSONRPCResponse | JSONRPCErrorResponse> {
        return this.dispatcher.dispatch(request, ctx);
    }

    /**
     * @internal Routes a notification through `Protocol._onnotification` so any
     * `setNotificationHandler`/`fallbackNotificationHandler` fires. Called by
     * `Client._collect` for non-progress notifications on the stateless path.
     */
    _routeNotification(notification: JSONRPCNotification): void {
        this._onnotification(notification);
    }

    /** @internal Called by `Client._negotiate` after a successful `server/discover`. */
    _setNegotiated(r: {
        serverCapabilities: ServerCapabilities;
        serverVersion: Implementation;
        instructions: string | undefined;
        protocolVersion: string;
    }): void {
        this._serverCapabilities = r.serverCapabilities;
        this._serverVersion = r.serverVersion;
        this._instructions = r.instructions;
        this._negotiatedProtocolVersion = r.protocolVersion;
        this._isStatelessConnection = true;
    }

    /** @internal */
    get _clientCapabilities(): ClientCapabilities {
        return this._capabilities;
    }

    /** @internal Public wrapper so the composing `Client` can run the local capability pre-check. */
    _assertCapabilityForMethod(method: RequestMethod | string): void {
        this.assertCapabilityForMethod(method);
    }

    /**
     * Throws when no pre-2026 session is available. Guards the pre-2026
     * connection-model methods so callers get a directed migration error
     * instead of `NotConnected` / `MethodNotFound`.
     */
    private _assertSession(via: string): void {
        if (!this.transport || this._isStatelessConnection) {
            throw new SdkError(
                SdkErrorCode.SessionRequired,
                `${this.constructor.name}.${via} requires a connected pre-2026 session. ` +
                    'See https://modelcontextprotocol.io/docs/migration#2026-06'
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // session-dependent (existing — bodies unchanged)
    //
    // `_initialize()` (extracted verbatim from the previous inline `connect()`
    // body) performs the legacy `initialize` handshake. `ping`,
    // `subscribeResource`, `unsubscribeResource`, and
    // `_setupListChangedHandler` use the persistent connection;
    // `Client._listChangedLoop` is the 2026 path.
    // ═══════════════════════════════════════════════════════════════════════

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
     * regardless of how the handler was registered. Installed as a {@linkcode Dispatcher}
     * middleware so it applies to both the legacy `_onrequest` path and the 2026-06
     * dispatch path.
     */
    private readonly _validationMiddleware: Middleware<ClientContext> = async (request, _ctx, next) => {
        if (request.method === 'elicitation/create') {
            const validatedRequest = parseSchema(ElicitRequestSchema, request);
            if (!validatedRequest.success) {
                const errorMessage =
                    validatedRequest.error instanceof Error ? validatedRequest.error.message : String(validatedRequest.error);
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid elicitation request: ${errorMessage}`);
            }

            const { params } = validatedRequest.data;
            params.mode = params.mode ?? 'form';
            const { supportsFormMode, supportsUrlMode } = getSupportedElicitationModes(this._capabilities.elicitation);

            if (params.mode === 'form' && !supportsFormMode) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Client does not support form-mode elicitation requests');
            }

            if (params.mode === 'url' && !supportsUrlMode) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Client does not support URL-mode elicitation requests');
            }

            const result = await next();

            const validationResult = parseSchema(ElicitResultSchema, result);
            if (!validationResult.success) {
                const errorMessage =
                    validationResult.error instanceof Error ? validationResult.error.message : String(validationResult.error);
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid elicitation result: ${errorMessage}`);
            }

            const validatedResult = validationResult.data;
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
        }

        if (request.method === 'sampling/createMessage') {
            const validatedRequest = parseSchema(CreateMessageRequestSchema, request);
            if (!validatedRequest.success) {
                const errorMessage =
                    validatedRequest.error instanceof Error ? validatedRequest.error.message : String(validatedRequest.error);
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid sampling request: ${errorMessage}`);
            }

            const { params } = validatedRequest.data;

            const result = await next();

            const hasTools = params.tools || params.toolChoice;
            const resultSchema = hasTools ? CreateMessageResultWithToolsSchema : CreateMessageResultSchema;
            const validationResult = parseSchema(resultSchema, result);
            if (!validationResult.success) {
                const errorMessage =
                    validationResult.error instanceof Error ? validationResult.error.message : String(validationResult.error);
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid sampling result: ${errorMessage}`);
            }

            return validationResult.data;
        }

        return next();
    };

    protected assertCapability(capability: keyof ServerCapabilities, method: string): void {
        if (!this._serverCapabilities?.[capability]) {
            throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support ${capability} (required for ${method})`);
        }
    }

    /**
     * Legacy `initialize` handshake; called from `Client.connect` when
     * the 2026-06 discover probe is unavailable or falls back.
     * @internal
     */
    async _initialize(transport: Transport, options?: RequestOptions): Promise<void> {
        const result = await this._requestWithSchema(
            {
                method: 'initialize',
                params: {
                    protocolVersion: this._supportedProtocolVersions[0] ?? LATEST_PROTOCOL_VERSION,
                    capabilities: this._capabilities,
                    clientInfo: this._clientInfo
                }
            },
            InitializeResultSchema,
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
        // HTTP transports must set the protocol version in each header after initialization.
        if (transport.setProtocolVersion) {
            transport.setProtocolVersion(result.protocolVersion);
        }

        this._instructions = result.instructions;

        await this.notification({
            method: 'notifications/initialized'
        });
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
        switch (method as RequestMethod) {
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
        switch (method as NotificationMethod) {
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

    /**
     * @deprecated `ping` is removed in the 2026-06 protocol. This method requires a pre-2026 connection.
     */
    async ping(options?: RequestOptions) {
        this._assertSession('ping');
        return this._requestWithSchema({ method: 'ping' }, EmptyResultSchema, options);
    }

    /**
     * Subscribes to change notifications for a resource. The server must support resource subscriptions.
     *
     * @deprecated Use `client.subscribe({ resourceSubscriptions: [uri] })` when connected to a 2026-06 server. This RPC form requires a pre-2026 connection.
     */
    async subscribeResource(params: SubscribeRequest['params'], options?: RequestOptions) {
        this._assertSession('subscribeResource (use client.subscribe)');
        return this._requestWithSchema({ method: 'resources/subscribe', params }, EmptyResultSchema, options);
    }

    /**
     * Unsubscribes from change notifications for a resource.
     *
     * @deprecated Use `client.subscribe()` and break out of the loop / abort its signal to stop, when connected to a 2026-06 server. This RPC form requires a pre-2026 connection.
     */
    async unsubscribeResource(params: UnsubscribeRequest['params'], options?: RequestOptions) {
        this._assertSession('unsubscribeResource (use client.subscribe)');
        return this._requestWithSchema({ method: 'resources/unsubscribe', params }, EmptyResultSchema, options);
    }

    /**
     * Set up a single list changed handler.
     * @internal
     */
    _setupListChangedHandler<T>(
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

    /**
     * Notifies the server that the client's root list has changed. Requires the `roots.listChanged` capability.
     *
     * @deprecated Under the 2026-06 protocol the server polls roots via MRTR; there is no client-to-server notification path. This form requires a pre-2026 connection.
     */
    async sendRootsListChanged() {
        this._assertSession('sendRootsListChanged');
        return this.notification({ method: 'notifications/roots/list_changed' });
    }
}
