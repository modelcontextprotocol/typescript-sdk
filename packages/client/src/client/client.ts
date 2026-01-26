import type {
    AnyObjectSchema,
    BaseRequestContext,
    CallToolRequest,
    ClientCapabilities,
    ClientNotification,
    ClientRequest,
    ClientResult,
    CompatibilityCallToolResultSchema,
    CompleteRequest,
    ContextInterface,
    ErrorInterceptionContext,
    ErrorInterceptionResult,
    GetPromptRequest,
    Implementation,
    JSONRPCRequest,
    JsonSchemaType,
    JsonSchemaValidator,
    jsonSchemaValidator,
    ListChangedHandlers,
    ListChangedOptions,
    ListPromptsRequest,
    ListResourcesRequest,
    ListResourceTemplatesRequest,
    ListRootsResult,
    ListToolsRequest,
    LoggingLevel,
    McpContext,
    MessageExtraInfo,
    Notification,
    ProtocolOptions,
    ReadResourceRequest,
    Request,
    RequestOptions,
    Result,
    SchemaOutput,
    ServerCapabilities,
    SubscribeRequest,
    Tool,
    Transport,
    UnsubscribeRequest,
    ZodV3Internal,
    ZodV4Internal
} from '@modelcontextprotocol/core';
import {
    AjvJsonSchemaValidator,
    assertClientRequestTaskCapability,
    assertToolsCallTaskCapability,
    CallToolResultSchema,
    CapabilityError,
    CompleteResultSchema,
    CreateMessageRequestSchema,
    CreateMessageResultSchema,
    CreateMessageResultWithToolsSchema,
    CreateTaskResultSchema,
    ElicitRequestSchema,
    ElicitResultSchema,
    EmptyResultSchema,
    getObjectShape,
    GetPromptResultSchema,
    InitializeResultSchema,
    isProtocolError,
    isZ4Schema,
    LATEST_PROTOCOL_VERSION,
    ListChangedOptionsBaseSchema,
    ListPromptsResultSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesResultSchema,
    ListRootsRequestSchema,
    ListToolsResultSchema,
    mergeCapabilities,
    PromptListChangedNotificationSchema,
    Protocol,
    ProtocolError,
    ReadResourceResultSchema,
    ResourceListChangedNotificationSchema,
    safeParse,
    StateError,
    SUPPORTED_PROTOCOL_VERSIONS,
    ToolListChangedNotificationSchema
} from '@modelcontextprotocol/core';

import { ExperimentalClientTasks } from '../experimental/tasks/client.js';
import type {
    ClientBuilderResult,
    ErrorContext,
    OnErrorHandler,
    OnErrorReturn,
    OnProtocolErrorHandler,
    OnProtocolErrorReturn
} from './builder.js';
import { ClientBuilder } from './builder.js';
import type { ClientRequestContext } from './context.js';
import { ClientContext } from './context.js';
import type {
    ClientMiddleware,
    ElicitationMiddleware,
    IncomingMiddleware,
    OutgoingMiddleware,
    ResourceReadMiddleware,
    SamplingMiddleware,
    ToolCallMiddleware
} from './middleware.js';
import { ClientMiddlewareManager } from './middleware.js';

/**
 * Elicitation default application helper. Applies defaults to the data based on the schema.
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
     * @default AjvJsonSchemaValidator
     *
     * @example
     * ```typescript
     * // ajv
     * const client = new Client(
     *   { name: 'my-client', version: '1.0.0' },
     *   {
     *     capabilities: {},
     *     jsonSchemaValidator: new AjvJsonSchemaValidator()
     *   }
     * );
     *
     * // @cfworker/json-schema
     * const client = new Client(
     *   { name: 'my-client', version: '1.0.0' },
     *   {
     *     capabilities: {},
     *     jsonSchemaValidator: new CfWorkerJsonSchemaValidator()
     *   }
     * );
     * ```
     */
    jsonSchemaValidator?: jsonSchemaValidator;

    /**
     * Configure handlers for list changed notifications (tools, prompts, resources).
     *
     * @example
     * ```typescript
     * const client = new Client(
     *   { name: 'my-client', version: '1.0.0' },
     *   {
     *     listChanged: {
     *       tools: {
     *         onChanged: (error, tools) => {
     *           if (error) {
     *             console.error('Failed to refresh tools:', error);
     *             return;
     *           }
     *           console.log('Tools updated:', tools);
     *         }
     *       },
     *       prompts: {
     *         onChanged: (error, prompts) => console.log('Prompts updated:', prompts)
     *       }
     *     }
     *   }
     * );
     * ```
     */
    listChanged?: ListChangedHandlers;
};

/**
 * An MCP client on top of a pluggable transport.
 *
 * The client will automatically begin the initialization flow with the server when connect() is called.
 *
 * To use with custom types, extend the base Request/Notification/Result types and pass them as type parameters:
 *
 * ```typescript
 * // Custom schemas
 * const CustomRequestSchema = RequestSchema.extend({...})
 * const CustomNotificationSchema = NotificationSchema.extend({...})
 * const CustomResultSchema = ResultSchema.extend({...})
 *
 * // Type aliases
 * type CustomRequest = z.infer<typeof CustomRequestSchema>
 * type CustomNotification = z.infer<typeof CustomNotificationSchema>
 * type CustomResult = z.infer<typeof CustomResultSchema>
 *
 * // Create typed client
 * const client = new Client<CustomRequest, CustomNotification, CustomResult>({
 *   name: "CustomClient",
 *   version: "1.0.0"
 * })
 * ```
 */
export class Client<
    RequestT extends Request = Request,
    NotificationT extends Notification = Notification,
    ResultT extends Result = Result
> extends Protocol<ClientRequest | RequestT, ClientNotification | NotificationT, ClientResult | ResultT> {
    private _serverCapabilities?: ServerCapabilities;
    private _serverVersion?: Implementation;
    private _capabilities: ClientCapabilities;
    private _instructions?: string;
    private _jsonSchemaValidator: jsonSchemaValidator;
    private _cachedToolOutputValidators: Map<string, JsonSchemaValidator<unknown>> = new Map();
    private _cachedKnownTaskTools: Set<string> = new Set();
    private _cachedRequiredTaskTools: Set<string> = new Set();
    private _experimental?: { tasks: ExperimentalClientTasks<RequestT, NotificationT, ResultT> };
    private _listChangedDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private _pendingListChangedConfig?: ListChangedHandlers;
    private readonly _middleware: ClientMiddlewareManager;

    // Error handlers (single callback pattern, matching McpServer)
    private _onErrorHandler?: OnErrorHandler;
    private _onProtocolErrorHandler?: OnProtocolErrorHandler;

    /**
     * Initializes this client with the given name and version information.
     */
    constructor(
        private _clientInfo: Implementation,
        options?: ClientOptions
    ) {
        super(options);
        this._capabilities = options?.capabilities ?? {};
        this._jsonSchemaValidator = options?.jsonSchemaValidator ?? new AjvJsonSchemaValidator();
        this._middleware = new ClientMiddlewareManager();

        // Store list changed config for setup after connection (when we know server capabilities)
        if (options?.listChanged) {
            this._pendingListChangedConfig = options.listChanged;
        }
    }

    /**
     * Gets the middleware manager for advanced middleware configuration.
     */
    get middleware(): ClientMiddlewareManager {
        return this._middleware;
    }

    /**
     * Registers universal middleware that runs for all request types.
     *
     * @param middleware - The middleware function to register
     * @returns This Client instance for chaining
     */
    useMiddleware(middleware: ClientMiddleware): this {
        this._middleware.useMiddleware(middleware);
        return this;
    }

    /**
     * Registers middleware for outgoing requests only.
     *
     * @param middleware - The outgoing middleware function to register
     * @returns This Client instance for chaining
     */
    useOutgoingMiddleware(middleware: OutgoingMiddleware): this {
        this._middleware.useOutgoingMiddleware(middleware);
        return this;
    }

    /**
     * Registers middleware for incoming requests only.
     *
     * @param middleware - The incoming middleware function to register
     * @returns This Client instance for chaining
     */
    useIncomingMiddleware(middleware: IncomingMiddleware): this {
        this._middleware.useIncomingMiddleware(middleware);
        return this;
    }

    /**
     * Registers middleware specifically for tool calls.
     *
     * @param middleware - The tool call middleware function to register
     * @returns This Client instance for chaining
     */
    useToolCallMiddleware(middleware: ToolCallMiddleware): this {
        this._middleware.useToolCallMiddleware(middleware);
        return this;
    }

    /**
     * Registers middleware specifically for resource reads.
     *
     * @param middleware - The resource read middleware function to register
     * @returns This Client instance for chaining
     */
    useResourceReadMiddleware(middleware: ResourceReadMiddleware): this {
        this._middleware.useResourceReadMiddleware(middleware);
        return this;
    }

    /**
     * Registers middleware specifically for sampling requests.
     *
     * @param middleware - The sampling middleware function to register
     * @returns This Client instance for chaining
     */
    useSamplingMiddleware(middleware: SamplingMiddleware): this {
        this._middleware.useSamplingMiddleware(middleware);
        return this;
    }

    /**
     * Registers middleware specifically for elicitation requests.
     *
     * @param middleware - The elicitation middleware function to register
     * @returns This Client instance for chaining
     */
    useElicitationMiddleware(middleware: ElicitationMiddleware): this {
        this._middleware.useElicitationMiddleware(middleware);
        return this;
    }

    /**
     * Creates a new ClientBuilder for fluent configuration.
     *
     * @example
     * ```typescript
     * const client = Client.builder()
     *   .name('my-client')
     *   .version('1.0.0')
     *   .capabilities({ sampling: {} })
     *   .onSamplingRequest(async (params) => {
     *     // Handle sampling request from server
     *     return { role: 'assistant', content: { type: 'text', text: '...' } };
     *   })
     *   .build();
     * ```
     */
    static builder(): ClientBuilder {
        return new ClientBuilder();
    }

    /**
     * Creates a Client from a ClientBuilderResult configuration.
     *
     * @param result - The result from ClientBuilder.build()
     * @returns A configured Client instance
     */
    static fromBuilderResult(result: ClientBuilderResult): Client {
        const client = new Client(result.clientInfo, {
            capabilities: result.capabilities,
            enforceStrictCapabilities: result.options.enforceStrictCapabilities,
            jsonSchemaValidator: result.jsonSchemaValidator,
            listChanged: result.listChanged
        });

        // Register handlers
        if (result.handlers.sampling) {
            client.setRequestHandler(
                CreateMessageRequestSchema,
                result.handlers.sampling as Parameters<typeof client.setRequestHandler>[1]
            );
        }

        if (result.handlers.elicitation) {
            client.setRequestHandler(ElicitRequestSchema, result.handlers.elicitation as Parameters<typeof client.setRequestHandler>[1]);
        }

        if (result.handlers.rootsList) {
            client.setRequestHandler(ListRootsRequestSchema, result.handlers.rootsList as Parameters<typeof client.setRequestHandler>[1]);
        }

        // Wire up error handlers to Protocol events
        if (result.errorHandlers.onError || result.errorHandlers.onProtocolError) {
            client.events.on('error', ({ error, context }) => {
                const errorContext = {
                    type: (context as 'sampling' | 'elicitation' | 'rootsList' | 'protocol') || 'protocol',
                    method: context || 'unknown',
                    requestId: 'unknown'
                };

                // Call the appropriate error handler based on context
                if (context === 'protocol' && result.errorHandlers.onProtocolError) {
                    (result.errorHandlers.onProtocolError as (error: Error, ctx: typeof errorContext) => void)(error, errorContext);
                } else if (result.errorHandlers.onError) {
                    (result.errorHandlers.onError as (error: Error, ctx: typeof errorContext) => void)(error, errorContext);
                }
            });
        }

        // Apply middleware from builder
        for (const middleware of result.middleware.universal) {
            client.useMiddleware(middleware);
        }
        for (const middleware of result.middleware.outgoing) {
            client.useOutgoingMiddleware(middleware);
        }
        for (const middleware of result.middleware.incoming) {
            client.useIncomingMiddleware(middleware);
        }
        for (const middleware of result.middleware.toolCall) {
            client.useToolCallMiddleware(middleware);
        }
        for (const middleware of result.middleware.resourceRead) {
            client.useResourceReadMiddleware(middleware);
        }
        for (const middleware of result.middleware.sampling) {
            client.useSamplingMiddleware(middleware);
        }
        for (const middleware of result.middleware.elicitation) {
            client.useElicitationMiddleware(middleware);
        }

        return client;
    }

    /**
     * Set up handlers for list changed notifications based on config and server capabilities.
     * This should only be called after initialization when server capabilities are known.
     * Handlers are silently skipped if the server doesn't advertise the corresponding listChanged capability.
     * @internal
     */
    private _setupListChangedHandlers(config: ListChangedHandlers): void {
        if (config.tools && this._serverCapabilities?.tools?.listChanged) {
            this._setupListChangedHandler('tools', ToolListChangedNotificationSchema, config.tools, async () => {
                const result = await this.listTools();
                return result.tools;
            });
        }

        if (config.prompts && this._serverCapabilities?.prompts?.listChanged) {
            this._setupListChangedHandler('prompts', PromptListChangedNotificationSchema, config.prompts, async () => {
                const result = await this.listPrompts();
                return result.prompts;
            });
        }

        if (config.resources && this._serverCapabilities?.resources?.listChanged) {
            this._setupListChangedHandler('resources', ResourceListChangedNotificationSchema, config.resources, async () => {
                const result = await this.listResources();
                return result.resources;
            });
        }
    }

    /**
     * Access experimental features.
     *
     * WARNING: These APIs are experimental and may change without notice.
     *
     * @experimental
     */
    get experimental(): { tasks: ExperimentalClientTasks<RequestT, NotificationT, ResultT> } {
        if (!this._experimental) {
            this._experimental = {
                tasks: new ExperimentalClientTasks(this)
            };
        }
        return this._experimental;
    }

    /**
     * Registers new capabilities. This can only be called before connecting to a transport.
     *
     * The new capabilities will be merged with any existing capabilities previously given (e.g., at initialization).
     */
    public registerCapabilities(capabilities: ClientCapabilities): void {
        if (this.transport) {
            throw StateError.registrationAfterConnect('capabilities');
        }

        this._capabilities = mergeCapabilities(this._capabilities, capabilities);
    }

    /**
     * Override request handler registration to enforce client-side validation for elicitation.
     */
    public override setRequestHandler<T extends AnyObjectSchema>(
        requestSchema: T,
        handler: (
            request: SchemaOutput<T>,
            extra: ContextInterface<ClientRequest | RequestT, ClientNotification | NotificationT, BaseRequestContext>
        ) => ClientResult | ResultT | Promise<ClientResult | ResultT>
    ): void {
        const shape = getObjectShape(requestSchema);
        const methodSchema = shape?.method;
        if (!methodSchema) {
            throw new Error('Schema is missing a method literal');
        }

        // Extract literal value using type-safe property access
        let methodValue: unknown;
        if (isZ4Schema(methodSchema)) {
            const v4Schema = methodSchema as unknown as ZodV4Internal;
            const v4Def = v4Schema._zod?.def;
            methodValue = v4Def?.value ?? v4Schema.value;
        } else {
            const v3Schema = methodSchema as unknown as ZodV3Internal;
            const legacyDef = v3Schema._def;
            methodValue = legacyDef?.value ?? v3Schema.value;
        }

        if (typeof methodValue !== 'string') {
            throw new TypeError('Schema method literal must be a string');
        }
        const method = methodValue;
        if (method === 'elicitation/create') {
            const wrappedHandler = async (
                request: SchemaOutput<T>,
                ctx: ContextInterface<ClientRequest | RequestT, ClientNotification | NotificationT, BaseRequestContext>
            ): Promise<ClientResult | ResultT> => {
                const validatedRequest = safeParse(ElicitRequestSchema, request);
                if (!validatedRequest.success) {
                    // Type guard: if success is false, error is guaranteed to exist
                    const errorMessage =
                        validatedRequest.error instanceof Error ? validatedRequest.error.message : String(validatedRequest.error);
                    throw ProtocolError.invalidParams(`Invalid elicitation request: ${errorMessage}`);
                }

                const { params } = validatedRequest.data;
                params.mode = params.mode ?? 'form';
                const { supportsFormMode, supportsUrlMode } = getSupportedElicitationModes(this._capabilities.elicitation);

                if (params.mode === 'form' && !supportsFormMode) {
                    throw ProtocolError.invalidParams('Client does not support form-mode elicitation requests');
                }

                if (params.mode === 'url' && !supportsUrlMode) {
                    throw ProtocolError.invalidParams('Client does not support URL-mode elicitation requests');
                }

                const result = await Promise.resolve(handler(request, ctx));

                // When task creation is requested, validate and return CreateTaskResult
                if (params.task) {
                    const taskValidationResult = safeParse(CreateTaskResultSchema, result);
                    if (!taskValidationResult.success) {
                        const errorMessage =
                            taskValidationResult.error instanceof Error
                                ? taskValidationResult.error.message
                                : String(taskValidationResult.error);
                        throw ProtocolError.invalidParams(`Invalid task creation result: ${errorMessage}`);
                    }
                    return taskValidationResult.data;
                }

                // For non-task requests, validate against ElicitResultSchema
                const validationResult = safeParse(ElicitResultSchema, result);
                if (!validationResult.success) {
                    // Type guard: if success is false, error is guaranteed to exist
                    const errorMessage =
                        validationResult.error instanceof Error ? validationResult.error.message : String(validationResult.error);
                    throw ProtocolError.invalidParams(`Invalid elicitation result: ${errorMessage}`);
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
            };

            // Install the wrapped handler
            return super.setRequestHandler(requestSchema, wrappedHandler as unknown as typeof handler);
        }

        if (method === 'sampling/createMessage') {
            const wrappedHandler = async (
                request: SchemaOutput<T>,
                ctx: ContextInterface<ClientRequest | RequestT, ClientNotification | NotificationT, BaseRequestContext>
            ): Promise<ClientResult | ResultT> => {
                const validatedRequest = safeParse(CreateMessageRequestSchema, request);
                if (!validatedRequest.success) {
                    const errorMessage =
                        validatedRequest.error instanceof Error ? validatedRequest.error.message : String(validatedRequest.error);
                    throw ProtocolError.invalidParams(`Invalid sampling request: ${errorMessage}`);
                }

                const { params } = validatedRequest.data;

                const result = await Promise.resolve(handler(request, ctx));

                // When task creation is requested, validate and return CreateTaskResult
                if (params.task) {
                    const taskValidationResult = safeParse(CreateTaskResultSchema, result);
                    if (!taskValidationResult.success) {
                        const errorMessage =
                            taskValidationResult.error instanceof Error
                                ? taskValidationResult.error.message
                                : String(taskValidationResult.error);
                        throw ProtocolError.invalidParams(`Invalid task creation result: ${errorMessage}`);
                    }
                    return taskValidationResult.data;
                }

                // For non-task requests, validate against appropriate schema based on tools presence
                const hasTools = params.tools || params.toolChoice;
                const resultSchema = hasTools ? CreateMessageResultWithToolsSchema : CreateMessageResultSchema;
                const validationResult = safeParse(resultSchema, result);
                if (!validationResult.success) {
                    const errorMessage =
                        validationResult.error instanceof Error ? validationResult.error.message : String(validationResult.error);
                    throw ProtocolError.invalidParams(`Invalid sampling result: ${errorMessage}`);
                }

                return validationResult.data;
            };

            // Install the wrapped handler
            return super.setRequestHandler(requestSchema, wrappedHandler as unknown as typeof handler);
        }

        // Other handlers use default behavior
        return super.setRequestHandler(requestSchema, handler);
    }

    protected createRequestContext(args: {
        request: JSONRPCRequest;
        abortController: AbortController;
        capturedTransport: Transport | undefined;
        extra?: MessageExtraInfo;
    }): ContextInterface<ClientRequest | RequestT, ClientNotification | NotificationT, BaseRequestContext> {
        const { request, abortController, capturedTransport, extra } = args;
        const sessionId = capturedTransport?.sessionId;

        // Build the MCP context using the helper from Protocol
        const mcpContext: McpContext = this.buildMcpContext({ request, sessionId });

        // Build the client request context (minimal, no HTTP details - client-specific)
        const requestCtx: ClientRequestContext = {
            signal: abortController.signal,
            authInfo: extra?.authInfo
        };

        // Return a ClientContext instance (task context is added by plugins if needed)
        return new ClientContext<RequestT, NotificationT, ResultT>({
            client: this,
            request,
            mcpContext,
            requestCtx
        });
    }

    protected assertCapability(capability: keyof ServerCapabilities, method: string): void {
        if (!this._serverCapabilities?.[capability]) {
            throw CapabilityError.serverDoesNotSupport(capability, method);
        }
    }

    override async connect(transport: Transport, options?: RequestOptions): Promise<void> {
        await super.connect(transport);
        // When transport sessionId is already set this means we are trying to reconnect.
        // In this case we don't need to initialize again.
        if (transport.sessionId !== undefined) {
            return;
        }
        try {
            const result = await this.request(
                {
                    method: 'initialize',
                    params: {
                        protocolVersion: LATEST_PROTOCOL_VERSION,
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

            if (!SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion)) {
                throw new Error(`Server's protocol version is not supported: ${result.protocolVersion}`);
            }

            this._serverCapabilities = result.capabilities;
            this._serverVersion = result.serverInfo;
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
     * After initialization has completed, this may be populated with information about the server's instructions.
     */
    getInstructions(): string | undefined {
        return this._instructions;
    }

    protected assertCapabilityForMethod(method: RequestT['method']): void {
        switch (method as ClientRequest['method']) {
            case 'logging/setLevel': {
                if (!this._serverCapabilities?.logging) {
                    throw CapabilityError.serverDoesNotSupport('logging', method);
                }
                break;
            }

            case 'prompts/get':
            case 'prompts/list': {
                if (!this._serverCapabilities?.prompts) {
                    throw CapabilityError.serverDoesNotSupport('prompts', method);
                }
                break;
            }

            case 'resources/list':
            case 'resources/templates/list':
            case 'resources/read':
            case 'resources/subscribe':
            case 'resources/unsubscribe': {
                if (!this._serverCapabilities?.resources) {
                    throw CapabilityError.serverDoesNotSupport('resources', method);
                }

                if (method === 'resources/subscribe' && !this._serverCapabilities.resources.subscribe) {
                    throw CapabilityError.serverDoesNotSupport('resources.subscribe', method);
                }

                break;
            }

            case 'tools/call':
            case 'tools/list': {
                if (!this._serverCapabilities?.tools) {
                    throw CapabilityError.serverDoesNotSupport('tools', method);
                }
                break;
            }

            case 'completion/complete': {
                if (!this._serverCapabilities?.completions) {
                    throw CapabilityError.serverDoesNotSupport('completions', method);
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

    protected assertNotificationCapability(method: NotificationT['method']): void {
        switch (method as ClientNotification['method']) {
            case 'notifications/roots/list_changed': {
                if (!this._capabilities.roots?.listChanged) {
                    throw CapabilityError.clientDoesNotSupport('roots.listChanged', method);
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
        // Task handlers are registered in Protocol constructor before _capabilities is initialized
        // Skip capability check for task methods during initialization
        if (!this._capabilities) {
            return;
        }

        switch (method) {
            case 'sampling/createMessage': {
                if (!this._capabilities.sampling) {
                    throw CapabilityError.clientDoesNotSupport('sampling', method);
                }
                break;
            }

            case 'elicitation/create': {
                if (!this._capabilities.elicitation) {
                    throw CapabilityError.clientDoesNotSupport('elicitation', method);
                }
                break;
            }

            case 'roots/list': {
                if (!this._capabilities.roots) {
                    throw CapabilityError.clientDoesNotSupport('roots', method);
                }
                break;
            }

            case 'tasks/get':
            case 'tasks/list':
            case 'tasks/result':
            case 'tasks/cancel': {
                if (!this._capabilities.tasks) {
                    throw CapabilityError.clientDoesNotSupport('tasks', method);
                }
                break;
            }

            case 'ping': {
                // No specific capability required for ping
                break;
            }
        }
    }

    protected assertTaskCapability(method: string): void {
        assertToolsCallTaskCapability(this._serverCapabilities?.tasks?.requests, method, 'Server');
    }

    protected assertTaskHandlerCapability(method: string): void {
        // Task handlers are registered in Protocol constructor before _capabilities is initialized
        // Skip capability check for task methods during initialization
        if (!this._capabilities) {
            return;
        }

        assertClientRequestTaskCapability(this._capabilities.tasks?.requests, method, 'Client');
    }

    async ping(options?: RequestOptions) {
        return this.request({ method: 'ping' }, EmptyResultSchema, options);
    }

    async complete(params: CompleteRequest['params'], options?: RequestOptions) {
        return this.request({ method: 'completion/complete', params }, CompleteResultSchema, options);
    }

    async setLoggingLevel(level: LoggingLevel, options?: RequestOptions) {
        return this.request({ method: 'logging/setLevel', params: { level } }, EmptyResultSchema, options);
    }

    async getPrompt(params: GetPromptRequest['params'], options?: RequestOptions) {
        return this.request({ method: 'prompts/get', params }, GetPromptResultSchema, options);
    }

    async listPrompts(params?: ListPromptsRequest['params'], options?: RequestOptions) {
        return this.request({ method: 'prompts/list', params }, ListPromptsResultSchema, options);
    }

    async listResources(params?: ListResourcesRequest['params'], options?: RequestOptions) {
        return this.request({ method: 'resources/list', params }, ListResourcesResultSchema, options);
    }

    async listResourceTemplates(params?: ListResourceTemplatesRequest['params'], options?: RequestOptions) {
        return this.request({ method: 'resources/templates/list', params }, ListResourceTemplatesResultSchema, options);
    }

    async readResource(params: ReadResourceRequest['params'], options?: RequestOptions) {
        return this.request({ method: 'resources/read', params }, ReadResourceResultSchema, options);
    }

    async subscribeResource(params: SubscribeRequest['params'], options?: RequestOptions) {
        return this.request({ method: 'resources/subscribe', params }, EmptyResultSchema, options);
    }

    async unsubscribeResource(params: UnsubscribeRequest['params'], options?: RequestOptions) {
        return this.request({ method: 'resources/unsubscribe', params }, EmptyResultSchema, options);
    }

    /**
     * Calls a tool and waits for the result. Automatically validates structured output if the tool has an outputSchema.
     *
     * For task-based execution with streaming behavior, use client.experimental.tasks.callToolStream() instead.
     */
    async callTool(
        params: CallToolRequest['params'],
        resultSchema: typeof CallToolResultSchema | typeof CompatibilityCallToolResultSchema = CallToolResultSchema,
        options?: RequestOptions
    ) {
        // Guard: required-task tools need experimental API
        if (this.isToolTaskRequired(params.name)) {
            throw ProtocolError.invalidRequest(
                `Tool "${params.name}" requires task-based execution. Use client.experimental.tasks.callToolStream() instead.`
            );
        }

        const result = await this.request({ method: 'tools/call', params }, resultSchema, options);

        // Check if the tool has an outputSchema
        const validator = this.getToolOutputValidator(params.name);
        if (validator) {
            // If tool has outputSchema, it MUST return structuredContent (unless it's an error)
            if (!result.structuredContent && !result.isError) {
                throw ProtocolError.invalidRequest(`Tool ${params.name} has an output schema but did not return structured content`);
            }

            // Only validate structured content if present (not when there's an error)
            if (result.structuredContent) {
                try {
                    // Validate the structured content against the schema
                    const validationResult = validator(result.structuredContent);

                    if (!validationResult.valid) {
                        throw ProtocolError.invalidParams(
                            `Structured content does not match the tool's output schema: ${validationResult.errorMessage}`
                        );
                    }
                } catch (error) {
                    if (isProtocolError(error)) {
                        throw error;
                    }
                    throw ProtocolError.invalidParams(
                        `Failed to validate structured content: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }
        }

        return result;
    }

    private isToolTask(toolName: string): boolean {
        if (!this._serverCapabilities?.tasks?.requests?.tools?.call) {
            return false;
        }

        return this._cachedKnownTaskTools.has(toolName);
    }

    /**
     * Check if a tool requires task-based execution.
     * Unlike isToolTask which includes 'optional' tools, this only checks for 'required'.
     */
    private isToolTaskRequired(toolName: string): boolean {
        return this._cachedRequiredTaskTools.has(toolName);
    }

    /**
     * Cache validators for tool output schemas.
     * Called after listTools() to pre-compile validators for better performance.
     */
    private cacheToolMetadata(tools: Tool[]): void {
        this._cachedToolOutputValidators.clear();
        this._cachedKnownTaskTools.clear();
        this._cachedRequiredTaskTools.clear();

        for (const tool of tools) {
            // If the tool has an outputSchema, create and cache the validator
            if (tool.outputSchema) {
                const toolValidator = this._jsonSchemaValidator.getValidator(tool.outputSchema as JsonSchemaType);
                this._cachedToolOutputValidators.set(tool.name, toolValidator);
            }

            // If the tool supports task-based execution, cache that information
            const taskSupport = tool.execution?.taskSupport;
            if (taskSupport === 'required' || taskSupport === 'optional') {
                this._cachedKnownTaskTools.add(tool.name);
            }
            if (taskSupport === 'required') {
                this._cachedRequiredTaskTools.add(tool.name);
            }
        }
    }

    /**
     * Get cached validator for a tool
     */
    private getToolOutputValidator(toolName: string): JsonSchemaValidator<unknown> | undefined {
        return this._cachedToolOutputValidators.get(toolName);
    }

    async listTools(params?: ListToolsRequest['params'], options?: RequestOptions) {
        const result = await this.request({ method: 'tools/list', params }, ListToolsResultSchema, options);

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
        notificationSchema: { shape: { method: { value: string } } },
        options: ListChangedOptions<T>,
        fetcher: () => Promise<T[]>
    ): void {
        // Validate options using Zod schema (validates autoRefresh and debounceMs)
        const parseResult = ListChangedOptionsBaseSchema.safeParse(options);
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
        this.setNotificationHandler(notificationSchema as AnyObjectSchema, handler);
    }

    async sendRootsListChanged() {
        return this.notification({ method: 'notifications/roots/list_changed' });
    }

    /**
     * Registers a handler for roots/list requests from the server.
     *
     * @param handler - Handler function that returns the list of roots
     * @returns This Client instance for chaining
     *
     * @example
     * ```typescript
     * client.onRootsList(async () => ({
     *   roots: [
     *     { uri: 'file:///workspace', name: 'Workspace' }
     *   ]
     * }));
     * ```
     */
    onRootsList(
        handler: (
            ctx: ContextInterface<ClientRequest | RequestT, ClientNotification | NotificationT, BaseRequestContext>
        ) => ListRootsResult | Promise<ListRootsResult>
    ): this {
        this.setRequestHandler(ListRootsRequestSchema, (_request, ctx) => handler(ctx));
        return this;
    }

    /**
     * Updates the error interceptor based on current handlers.
     * This combines both onError and onProtocolError handlers into a single interceptor.
     */
    private _updateErrorInterceptor(): void {
        if (!this._onErrorHandler && !this._onProtocolErrorHandler) {
            // No handlers, clear the interceptor
            this.setErrorInterceptor(undefined);
            return;
        }

        this.setErrorInterceptor(async (error: Error, ctx: ErrorInterceptionContext): Promise<ErrorInterceptionResult | void> => {
            const errorContext: ErrorContext = {
                type: ctx.type === 'protocol' ? 'protocol' : (ctx.method as ErrorContext['type']) || 'sampling',
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

    private _clearOnErrorHandler(): void {
        this._onErrorHandler = undefined;
        this._updateErrorInterceptor();
    }

    private _clearOnProtocolErrorHandler(): void {
        this._onProtocolErrorHandler = undefined;
        this._updateErrorInterceptor();
    }

    /**
     * Registers an error handler for application errors in sampling/elicitation/rootsList handlers.
     *
     * The handler receives the error and a context object with information about where
     * the error occurred. It can optionally return a custom error response that will
     * modify the error sent to the server.
     *
     * Note: This is a single-handler pattern. Setting a new handler replaces any previous one.
     * The handler is awaited, so async handlers are fully supported.
     *
     * @param handler - Error handler function
     * @returns Unsubscribe function
     *
     * @example
     * ```typescript
     * const unsubscribe = client.onError(async (error, ctx) => {
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
     * const unsubscribe = client.onProtocolError(async (error, ctx) => {
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
}
