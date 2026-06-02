import type {
    BaseContext,
    ClientCapabilities,
    CreateMessageRequest,
    CreateMessageRequestParamsBase,
    CreateMessageRequestParamsWithTools,
    CreateMessageResult,
    CreateMessageResultWithTools,
    DiscoverResult,
    ElicitRequestFormParams,
    ElicitRequestURLParams,
    ElicitResult,
    Implementation,
    InitializeRequest,
    InitializeResult,
    JSONRPCRequest,
    JSONRPCResponse,
    JsonSchemaType,
    jsonSchemaValidator,
    ListRootsRequest,
    LoggingLevel,
    LoggingMessageNotification,
    MessageExtraInfo,
    NotificationMethod,
    NotificationOptions,
    ProtocolOptions,
    RequestMetaEnvelope,
    RequestMethod,
    RequestOptions,
    ResourceUpdatedNotification,
    Result,
    ServerCapabilities,
    ServerContext,
    StatelessDispatchContext,
    ToolResultContent,
    ToolUseContent,
    Transport
} from '@modelcontextprotocol/core';
import {
    CallToolRequestSchema,
    CallToolResultSchema,
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    CreateMessageResultSchema,
    CreateMessageResultWithToolsSchema,
    ElicitResultSchema,
    EmptyResultSchema,
    isStatefulProtocolVersion,
    LATEST_PROTOCOL_VERSION,
    ListRootsResultSchema,
    LoggingLevelSchema,
    mergeCapabilities,
    NotImplementedYetError,
    parseSchema,
    Protocol,
    PROTOCOL_VERSION_META_KEY,
    ProtocolError,
    ProtocolErrorCode,
    RequestMetaEnvelopeSchema,
    SdkError,
    SdkErrorCode,
    UnsupportedProtocolVersionError
} from '@modelcontextprotocol/core';
import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/server/_shims';

export type ServerOptions = ProtocolOptions & {
    /**
     * Capabilities to advertise as being supported by this server.
     */
    capabilities?: ServerCapabilities;

    /**
     * Optional instructions describing how to use the server and its features.
     */
    instructions?: string;

    /**
     * JSON Schema validator for elicitation response validation.
     *
     * The validator is used to validate user input returned from elicitation
     * requests against the requested schema.
     *
     * @default Runtime-selected validator (AJV-backed on Node.js, `@cfworker/json-schema`-backed on browser/workerd runtimes)
     */
    jsonSchemaValidator?: jsonSchemaValidator;
};

/**
 * Client→server request methods that earlier protocol revisions defined and revision
 * 2026-07-28 removed: lifecycle and per-session methods have no meaning when every
 * request is self-contained (`initialize`, `ping`, `logging/setLevel` — replaced by the
 * per-request `logLevel` `_meta` claim) and resource subscriptions moved to
 * `subscriptions/listen` (`resources/subscribe`, `resources/unsubscribe`). They are
 * rejected on the stateless dispatch path with `-32601` (Method not found), exactly as
 * if the method did not exist — handlers for them remain registered only to serve
 * stateful-era traffic.
 */
const STATELESS_REMOVED_METHODS: ReadonlySet<string> = new Set([
    'initialize',
    'ping',
    'logging/setLevel',
    'resources/subscribe',
    'resources/unsubscribe'
]);

/**
 * An MCP server on top of a pluggable transport.
 *
 * This server will automatically respond to the initialization flow as initiated from the client.
 *
 * @deprecated Use {@linkcode server/mcp.McpServer | McpServer} instead for the high-level API. Only use `Server` for advanced use cases.
 */
export class Server extends Protocol<ServerContext> {
    private _clientCapabilities?: ClientCapabilities;
    private _clientVersion?: Implementation;
    private _capabilities: ServerCapabilities;
    private _instructions?: string;
    private _jsonSchemaValidator: jsonSchemaValidator;

    /**
     * Callback for when initialization has fully completed (i.e., the client has sent an `notifications/initialized` notification).
     */
    oninitialized?: () => void;

    /**
     * Initializes this server with the given name and version information.
     */
    constructor(
        private _serverInfo: Implementation,
        options?: ServerOptions
    ) {
        super(options);
        this._capabilities = options?.capabilities ? { ...options.capabilities } : {};
        this._instructions = options?.instructions;
        this._jsonSchemaValidator = options?.jsonSchemaValidator ?? new DefaultJsonSchemaValidator();

        this.setRequestHandler('initialize', request => this._oninitialize(request));
        // Discovery is served built-in, like ping: the response is derived entirely
        // from the server's own configuration, so there is nothing for user code to
        // decide. Registering a user handler for 'server/discover' replaces this default.
        this.setRequestHandler('server/discover', () => this._ondiscover());
        this.setNotificationHandler('notifications/initialized', () => this.oninitialized?.());

        if (this._capabilities.logging) {
            this._registerLoggingHandler();
        }
    }

    private _registerLoggingHandler(): void {
        this.setRequestHandler('logging/setLevel', async (request, ctx) => {
            const transportSessionId: string | undefined =
                ctx.sessionId || (ctx.http?.req?.headers.get('mcp-session-id') as string) || undefined;
            const { level } = request.params;
            const parseResult = parseSchema(LoggingLevelSchema, level);
            if (parseResult.success) {
                this._loggingLevels.set(transportSessionId, parseResult.data);
            }
            return {};
        });
    }

    /**
     * Attaches to the given transport, starts it, and starts listening for messages.
     *
     * Installs the stateless dispatch handlers on transports that support
     * per-request routing (the seam is optional on the {@linkcode Transport}
     * contract) before `super.connect()` starts the transport, so the first
     * message cannot arrive before the router is wired.
     */
    override async connect(transport: Transport): Promise<void> {
        transport.setStatelessHandlers?.({
            dispatch: (request, ctx) => this._dispatchStateless(request, ctx)
        });
        await super.connect(transport);
    }

    /**
     * Serves one stateless (draft-protocol-version) request routed here by the
     * transport, outside the `onmessage` / session flow.
     *
     * Order of checks: method gate (`-32601`), envelope acceptance (`-32602`),
     * version negotiation (`-32004`), then handler dispatch. The method gate runs
     * first because JSON-RPC resolves the method before interpreting params; the
     * envelope is validated before handler lookup so that a request with an
     * incomplete `_meta` is rejected for the actual problem (`-32602`) rather
     * than reporting `-32601` for a method this server happens not to implement.
     */
    private async _dispatchStateless(request: JSONRPCRequest, dispatchCtx: StatelessDispatchContext): Promise<JSONRPCResponse> {
        // Removed-method gate. This protocol revision removed these RPCs, but the
        // handlers for them are still registered to serve stateful-era traffic, so
        // the lookup in invokeRequestHandler() would happily serve them. The
        // response shape is byte-identical to the unknown-method -32601.
        if (STATELESS_REMOVED_METHODS.has(request.method)) {
            return {
                jsonrpc: '2.0',
                id: request.id,
                error: { code: ProtocolErrorCode.MethodNotFound, message: 'Method not found' }
            };
        }

        // Envelope acceptance. This revision requires the protocol version, client
        // info, and client capabilities in every request's _meta. The wire schemas
        // deliberately stay lenient so they also parse earlier-revision requests
        // (no envelope); era-requiredness is enforced here, at dispatch.
        const parsed = parseSchema(RequestMetaEnvelopeSchema, request.params?._meta ?? {});
        if (!parsed.success) {
            const issues = [...new Set(parsed.error.issues.map(issue => issue.path.join('.')).filter(Boolean))].join(', ');
            return {
                jsonrpc: '2.0',
                id: request.id,
                error: {
                    code: ProtocolErrorCode.InvalidParams,
                    message:
                        `Invalid request _meta envelope${issues ? ` (${issues})` : ''}: this protocol revision requires ` +
                        `${PROTOCOL_VERSION_META_KEY}, ${CLIENT_INFO_META_KEY}, and ${CLIENT_CAPABILITIES_META_KEY} on every request`
                }
            };
        }
        const envelope = parsed.data;

        // Version negotiation. The stateless path serves only the non-stateful
        // revisions this server lists; anything else gets -32004 with the full
        // supported list so the caller can pick a mutual version and retry.
        // (Transports only route non-stateful claims here; re-checking against the
        // envelope keeps the error shape with the dispatch logic and covers claims
        // the routing layer could not see.)
        const requested = envelope[PROTOCOL_VERSION_META_KEY];
        if (isStatefulProtocolVersion(requested) || !this._supportedProtocolVersions.includes(requested)) {
            const error = new UnsupportedProtocolVersionError({ supported: [...this._supportedProtocolVersions], requested });
            return {
                jsonrpc: '2.0',
                id: request.id,
                error: { code: error.code, message: error.message, data: { supported: error.supported, requested: error.requested } }
            };
        }

        return await this.invokeRequestHandler(request, this._buildStatelessContext(request, envelope, dispatchCtx));
    }

    /**
     * Builds the per-request handler context for a stateless dispatch. Every fact
     * is sourced from the request's own `_meta` envelope or the transport's
     * per-request dispatch context — never from handshake or session state, and
     * never inherited from a previous request.
     */
    private _buildStatelessContext(
        request: JSONRPCRequest,
        envelope: RequestMetaEnvelope,
        dispatchCtx: StatelessDispatchContext
    ): ServerContext {
        return {
            sessionId: undefined,
            mcpReq: {
                id: request.id,
                method: request.method,
                protocolVersion: envelope[PROTOCOL_VERSION_META_KEY],
                _meta: request.params?._meta,
                signal: dispatchCtx.signal ?? new AbortController().signal,
                send: (() => {
                    // TODO(SEP-2322 MRTR PR): under this revision, server-to-client
                    // interactions are embedded in results as input requests; there is
                    // no backchannel to send a standalone request on.
                    throw new NotImplementedYetError('Server-to-client requests are not supported on the stateless path yet');
                }) as ServerContext['mcpReq']['send'],
                notify: async notification => {
                    // Request-scoped notifications ride the originating response stream.
                    await dispatchCtx.sendNotification?.({ jsonrpc: '2.0', ...notification });
                },
                log: async () => {
                    // TODO(per-request logging commit): emission is gated on the request's
                    // logLevel _meta claim. Without a claim this revision forbids
                    // notifications/message for the request, so nothing is emitted until
                    // the per-request filter lands.
                },
                elicitInput: () => {
                    // TODO(SEP-2322 MRTR PR): elicitation becomes an input request
                    // embedded in this request's result.
                    throw new NotImplementedYetError('Eliciting user input is not supported on the stateless path yet');
                },
                requestSampling: () => {
                    // TODO(SEP-2322 MRTR PR): sampling becomes an input request embedded
                    // in this request's result.
                    throw new NotImplementedYetError('Requesting sampling is not supported on the stateless path yet');
                }
            },
            client: {
                capabilities: envelope[CLIENT_CAPABILITIES_META_KEY],
                info: envelope[CLIENT_INFO_META_KEY]
            },
            http: dispatchCtx.authInfo ? { authInfo: dispatchCtx.authInfo } : undefined
        };
    }

    protected override buildContext(ctx: BaseContext, transportInfo?: MessageExtraInfo): ServerContext {
        // Only create http when there's actual HTTP transport info or auth info
        const hasHttpInfo = ctx.http || transportInfo?.request || transportInfo?.closeSSEStream || transportInfo?.closeStandaloneSSEStream;
        return {
            ...ctx,
            mcpReq: {
                ...ctx.mcpReq,
                log: (level, data, logger) => this.sendLoggingMessage({ level, data, logger }),
                elicitInput: (params, options) => this.elicitInput(params, options),
                requestSampling: (params, options) => this.createMessage(params, options)
            },
            // Sourced from the handshake state retained at initialize - the only source that exists today.
            // Before the handshake completes (only `ping` is legal there), capabilities is `{}` and info undefined.
            client: {
                capabilities: this._clientCapabilities ?? {},
                info: this._clientVersion
            },
            http: hasHttpInfo
                ? {
                      ...ctx.http,
                      req: transportInfo?.request,
                      closeSSE: transportInfo?.closeSSEStream,
                      closeStandaloneSSE: transportInfo?.closeStandaloneSSEStream
                  }
                : undefined
        };
    }

    // Map log levels by session id
    private _loggingLevels = new Map<string | undefined, LoggingLevel>();

    // Map LogLevelSchema to severity index
    private readonly LOG_LEVEL_SEVERITY = new Map(LoggingLevelSchema.options.map((level, index) => [level, index]));

    // Is a message with the given level ignored in the log level set for the given session id?
    private isMessageIgnored = (level: LoggingLevel, sessionId?: string): boolean => {
        const currentLevel = this._loggingLevels.get(sessionId);
        return currentLevel ? this.LOG_LEVEL_SEVERITY.get(level)! < this.LOG_LEVEL_SEVERITY.get(currentLevel)! : false;
    };

    /**
     * Registers new capabilities. This can only be called before connecting to a transport.
     *
     * The new capabilities will be merged with any existing capabilities previously given (e.g., at initialization).
     */
    public registerCapabilities(capabilities: ServerCapabilities): void {
        if (this.transport) {
            throw new SdkError(SdkErrorCode.AlreadyConnected, 'Cannot register capabilities after connecting to transport');
        }
        const hadLogging = !!this._capabilities.logging;
        this._capabilities = mergeCapabilities(this._capabilities, capabilities);
        if (!hadLogging && this._capabilities.logging) {
            this._registerLoggingHandler();
        }
    }

    /**
     * Enforces server-side validation for `tools/call` results regardless of how the
     * handler was registered.
     */
    protected override _wrapHandler(
        method: string,
        handler: (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result>
    ): (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result> {
        if (method !== 'tools/call') {
            return handler;
        }
        return async (request, ctx) => {
            const validatedRequest = parseSchema(CallToolRequestSchema, request);
            if (!validatedRequest.success) {
                const errorMessage =
                    validatedRequest.error instanceof Error ? validatedRequest.error.message : String(validatedRequest.error);
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid tools/call request: ${errorMessage}`);
            }

            const result = await handler(request, ctx);

            const validationResult = parseSchema(CallToolResultSchema, result);
            if (!validationResult.success) {
                const errorMessage =
                    validationResult.error instanceof Error ? validationResult.error.message : String(validationResult.error);
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid tools/call result: ${errorMessage}`);
            }

            return validationResult.data;
        };
    }

    protected assertCapabilityForMethod(method: RequestMethod | string): void {
        switch (method) {
            case 'sampling/createMessage': {
                if (!this._clientCapabilities?.sampling) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support sampling (required for ${method})`);
                }
                break;
            }

            case 'elicitation/create': {
                if (!this._clientCapabilities?.elicitation) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support elicitation (required for ${method})`);
                }
                break;
            }

            case 'roots/list': {
                if (!this._clientCapabilities?.roots) {
                    throw new SdkError(
                        SdkErrorCode.CapabilityNotSupported,
                        `Client does not support listing roots (required for ${method})`
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

    protected assertNotificationCapability(method: NotificationMethod | string): void {
        switch (method) {
            case 'notifications/message': {
                if (!this._capabilities.logging) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support logging (required for ${method})`);
                }
                break;
            }

            case 'notifications/resources/updated':
            case 'notifications/resources/list_changed': {
                if (!this._capabilities.resources) {
                    throw new SdkError(
                        SdkErrorCode.CapabilityNotSupported,
                        `Server does not support notifying about resources (required for ${method})`
                    );
                }
                break;
            }

            case 'notifications/tools/list_changed': {
                if (!this._capabilities.tools) {
                    throw new SdkError(
                        SdkErrorCode.CapabilityNotSupported,
                        `Server does not support notifying of tool list changes (required for ${method})`
                    );
                }
                break;
            }

            case 'notifications/prompts/list_changed': {
                if (!this._capabilities.prompts) {
                    throw new SdkError(
                        SdkErrorCode.CapabilityNotSupported,
                        `Server does not support notifying of prompt list changes (required for ${method})`
                    );
                }
                break;
            }

            case 'notifications/elicitation/complete': {
                if (!this._clientCapabilities?.elicitation?.url) {
                    throw new SdkError(
                        SdkErrorCode.CapabilityNotSupported,
                        `Client does not support URL elicitation (required for ${method})`
                    );
                }
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
            case 'completion/complete': {
                if (!this._capabilities.completions) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support completions (required for ${method})`);
                }
                break;
            }

            case 'logging/setLevel': {
                if (!this._capabilities.logging) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support logging (required for ${method})`);
                }
                break;
            }

            case 'prompts/get':
            case 'prompts/list': {
                if (!this._capabilities.prompts) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support prompts (required for ${method})`);
                }
                break;
            }

            case 'resources/list':
            case 'resources/templates/list':
            case 'resources/read': {
                if (!this._capabilities.resources) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support resources (required for ${method})`);
                }
                break;
            }

            case 'tools/call':
            case 'tools/list': {
                if (!this._capabilities.tools) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support tools (required for ${method})`);
                }
                break;
            }

            case 'ping':
            case 'initialize':
            case 'server/discover': {
                // No specific capability required for these methods
                break;
            }
        }
    }

    private async _oninitialize(request: InitializeRequest): Promise<InitializeResult> {
        const requestedVersion = request.params.protocolVersion;

        this._clientCapabilities = request.params.capabilities;
        this._clientVersion = request.params.clientInfo;

        // initialize negotiates stateful versions only; an empty stateful subset falls back to the
        // latest released version, matching the previous behavior for an empty supported list.
        const statefulVersions = this._supportedProtocolVersions.filter(version => isStatefulProtocolVersion(version));
        const protocolVersion = statefulVersions.includes(requestedVersion)
            ? requestedVersion
            : (statefulVersions[0] ?? LATEST_PROTOCOL_VERSION);

        this._negotiatedProtocolVersion = protocolVersion;
        this.transport?.setProtocolVersion?.(protocolVersion);

        return {
            protocolVersion,
            capabilities: this.getCapabilities(),
            serverInfo: this._serverInfo,
            ...(this._instructions && { instructions: this._instructions })
        };
    }

    /**
     * Built-in handler for `server/discover`: advertises the protocol versions this
     * server is configured to support (the same list an UnsupportedProtocolVersionError
     * reports in `error.data.supported`), its capabilities, its implementation info,
     * and its instructions (when configured).
     *
     * Discovery is connection-less: like `ping`, it is answered both before and after
     * the initialize handshake, and on the stateless dispatch path.
     */
    private _ondiscover(): DiscoverResult {
        return {
            supportedVersions: [...this._supportedProtocolVersions],
            capabilities: this._discoverCapabilities(),
            serverInfo: this._serverInfo,
            ...(this._instructions && { instructions: this._instructions })
        };
    }

    /**
     * The capabilities `server/discover` advertises: the declared capabilities minus
     * the subscription-delivery flags (`prompts.listChanged`, `resources.listChanged`,
     * `resources.subscribe`, `tools.listChanged`).
     *
     * Under the per-request protocol revisions those notifications are delivered
     * through `subscriptions/listen`, which this SDK does not implement yet, so
     * discovery must not advertise them: advertised capabilities reflect what RPC
     * handlers actually honor. The flags still appear in the initialize result, where
     * the stateful-era notification flow delivers them.
     */
    // TODO(subscriptions/listen PR): stop withholding these flags once listen delivers them.
    private _discoverCapabilities(): ServerCapabilities {
        const advertised: ServerCapabilities = { ...this._capabilities };
        if (advertised.prompts) {
            advertised.prompts = { ...advertised.prompts };
            delete advertised.prompts.listChanged;
        }
        if (advertised.resources) {
            advertised.resources = { ...advertised.resources };
            delete advertised.resources.subscribe;
            delete advertised.resources.listChanged;
        }
        if (advertised.tools) {
            advertised.tools = { ...advertised.tools };
            delete advertised.tools.listChanged;
        }
        return advertised;
    }

    /**
     * After initialization has completed, this will be populated with the client's reported capabilities.
     *
     * Inside a request handler, prefer `ctx.client.capabilities`, which reads the same facts per request.
     */
    getClientCapabilities(): ClientCapabilities | undefined {
        return this._clientCapabilities;
    }

    /**
     * After initialization has completed, this will be populated with information about the client's name and version.
     *
     * Inside a request handler, prefer `ctx.client.info`, which reads the same facts per request.
     */
    getClientVersion(): Implementation | undefined {
        return this._clientVersion;
    }

    /**
     * Returns the current server capabilities.
     */
    public getCapabilities(): ServerCapabilities {
        return this._capabilities;
    }

    async ping() {
        return this._requestWithSchema({ method: 'ping' }, EmptyResultSchema);
    }

    /**
     * Request LLM sampling from the client (without tools).
     * Returns single content block for backwards compatibility.
     */
    async createMessage(params: CreateMessageRequestParamsBase, options?: RequestOptions): Promise<CreateMessageResult>;

    /**
     * Request LLM sampling from the client with tool support.
     * Returns content that may be a single block or array (for parallel tool calls).
     */
    async createMessage(params: CreateMessageRequestParamsWithTools, options?: RequestOptions): Promise<CreateMessageResultWithTools>;

    /**
     * Request LLM sampling from the client.
     * When tools may or may not be present, returns the union type.
     */
    async createMessage(
        params: CreateMessageRequest['params'],
        options?: RequestOptions
    ): Promise<CreateMessageResult | CreateMessageResultWithTools>;

    // Implementation
    async createMessage(
        params: CreateMessageRequest['params'],
        options?: RequestOptions
    ): Promise<CreateMessageResult | CreateMessageResultWithTools> {
        // Capability check - only required when tools/toolChoice are provided
        if ((params.tools || params.toolChoice) && !this._clientCapabilities?.sampling?.tools) {
            throw new SdkError(SdkErrorCode.CapabilityNotSupported, 'Client does not support sampling tools capability.');
        }

        // Message structure validation - always validate tool_use/tool_result pairs.
        // These may appear even without tools/toolChoice in the current request when
        // a previous sampling request returned tool_use and this is a follow-up with results.
        if (params.messages.length > 0) {
            const lastMessage = params.messages.at(-1)!;
            const lastContent = Array.isArray(lastMessage.content) ? lastMessage.content : [lastMessage.content];
            const hasToolResults = lastContent.some(c => c.type === 'tool_result');

            const previousMessage = params.messages.length > 1 ? params.messages.at(-2) : undefined;
            const previousContent = previousMessage
                ? Array.isArray(previousMessage.content)
                    ? previousMessage.content
                    : [previousMessage.content]
                : [];
            const hasPreviousToolUse = previousContent.some(c => c.type === 'tool_use');

            if (hasToolResults) {
                if (lastContent.some(c => c.type !== 'tool_result')) {
                    throw new ProtocolError(
                        ProtocolErrorCode.InvalidParams,
                        'The last message must contain only tool_result content if any is present'
                    );
                }
                if (!hasPreviousToolUse) {
                    throw new ProtocolError(
                        ProtocolErrorCode.InvalidParams,
                        'tool_result blocks are not matching any tool_use from the previous message'
                    );
                }
            }
            if (hasPreviousToolUse) {
                const toolUseIds = new Set(previousContent.filter(c => c.type === 'tool_use').map(c => (c as ToolUseContent).id));
                const toolResultIds = new Set(
                    lastContent.filter(c => c.type === 'tool_result').map(c => (c as ToolResultContent).toolUseId)
                );
                if (toolUseIds.size !== toolResultIds.size || ![...toolUseIds].every(id => toolResultIds.has(id))) {
                    throw new ProtocolError(
                        ProtocolErrorCode.InvalidParams,
                        'ids of tool_result blocks and tool_use blocks from previous message do not match'
                    );
                }
            }
        }

        // Use different schemas based on whether tools are provided
        if (params.tools) {
            return this._requestWithSchema({ method: 'sampling/createMessage', params }, CreateMessageResultWithToolsSchema, options);
        }
        return this._requestWithSchema({ method: 'sampling/createMessage', params }, CreateMessageResultSchema, options);
    }

    /**
     * Creates an elicitation request for the given parameters.
     * For backwards compatibility, `mode` may be omitted for form requests and will default to `"form"`.
     * @param params The parameters for the elicitation request.
     * @param options Optional request options.
     * @returns The result of the elicitation request.
     */
    async elicitInput(params: ElicitRequestFormParams | ElicitRequestURLParams, options?: RequestOptions): Promise<ElicitResult> {
        const mode = (params.mode ?? 'form') as 'form' | 'url';

        switch (mode) {
            case 'url': {
                if (!this._clientCapabilities?.elicitation?.url) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, 'Client does not support url elicitation.');
                }

                const urlParams = params as ElicitRequestURLParams;
                return this._requestWithSchema({ method: 'elicitation/create', params: urlParams }, ElicitResultSchema, options);
            }
            case 'form': {
                if (!this._clientCapabilities?.elicitation?.form) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, 'Client does not support form elicitation.');
                }

                const formParams: ElicitRequestFormParams =
                    params.mode === 'form' ? (params as ElicitRequestFormParams) : { ...(params as ElicitRequestFormParams), mode: 'form' };

                const result = await this._requestWithSchema(
                    { method: 'elicitation/create', params: formParams },
                    ElicitResultSchema,
                    options
                );

                if (result.action === 'accept' && result.content && formParams.requestedSchema) {
                    try {
                        const validator = this._jsonSchemaValidator.getValidator(formParams.requestedSchema as JsonSchemaType);
                        const validationResult = validator(result.content);

                        if (!validationResult.valid) {
                            throw new ProtocolError(
                                ProtocolErrorCode.InvalidParams,
                                `Elicitation response content does not match requested schema: ${validationResult.errorMessage}`
                            );
                        }
                    } catch (error) {
                        if (error instanceof ProtocolError) {
                            throw error;
                        }
                        throw new ProtocolError(
                            ProtocolErrorCode.InternalError,
                            `Error validating elicitation response: ${error instanceof Error ? error.message : String(error)}`
                        );
                    }
                }
                return result;
            }
        }
    }

    /**
     * Creates a reusable callback that, when invoked, will send a `notifications/elicitation/complete`
     * notification for the specified elicitation ID.
     *
     * @param elicitationId The ID of the elicitation to mark as complete.
     * @param options Optional notification options. Useful when the completion notification should be related to a prior request.
     * @returns A function that emits the completion notification when awaited.
     */
    createElicitationCompletionNotifier(elicitationId: string, options?: NotificationOptions): () => Promise<void> {
        if (!this._clientCapabilities?.elicitation?.url) {
            throw new SdkError(
                SdkErrorCode.CapabilityNotSupported,
                'Client does not support URL elicitation (required for notifications/elicitation/complete)'
            );
        }

        return () =>
            this.notification(
                {
                    method: 'notifications/elicitation/complete',
                    params: {
                        elicitationId
                    }
                },
                options
            );
    }

    async listRoots(params?: ListRootsRequest['params'], options?: RequestOptions) {
        return this._requestWithSchema({ method: 'roots/list', params }, ListRootsResultSchema, options);
    }

    /**
     * Sends a logging message to the client, if connected.
     * Note: You only need to send the parameters object, not the entire JSON-RPC message.
     * @see {@linkcode LoggingMessageNotification}
     * @param params
     * @param sessionId Optional for stateless transports and backward compatibility.
     */
    async sendLoggingMessage(params: LoggingMessageNotification['params'], sessionId?: string) {
        if (this._capabilities.logging && !this.isMessageIgnored(params.level, sessionId)) {
            return this.notification({ method: 'notifications/message', params });
        }
    }

    async sendResourceUpdated(params: ResourceUpdatedNotification['params']) {
        return this.notification({
            method: 'notifications/resources/updated',
            params
        });
    }

    async sendResourceListChanged() {
        return this.notification({
            method: 'notifications/resources/list_changed'
        });
    }

    async sendToolListChanged() {
        return this.notification({ method: 'notifications/tools/list_changed' });
    }

    async sendPromptListChanged() {
        return this.notification({ method: 'notifications/prompts/list_changed' });
    }
}
