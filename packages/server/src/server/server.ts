import type {
    BaseContext,
    ClientCapabilities,
    CreateMessageRequest,
    CreateMessageRequestParamsBase,
    CreateMessageRequestParamsWithTools,
    CreateMessageResult,
    CreateMessageResultWithTools,
    ElicitRequestFormParams,
    ElicitRequestURLParams,
    ElicitResult,
    Implementation,
    InitializeRequest,
    InitializeResult,
    JSONRPCRequest,
    JsonSchemaType,
    jsonSchemaValidator,
    ListRootsRequest,
    LoggingLevel,
    LoggingMessageNotification,
    MessageExtraInfo,
    NotificationMethod,
    NotificationOptions,
    ProtocolOptions,
    RequestMethod,
    RequestOptions,
    ResourceUpdatedNotification,
    Result,
    ServerCapabilities,
    ServerContext,
    ServerDiscoverResult,
    StandardSchemaV1,
    ToolResultContent,
    ToolUseContent
} from '@modelcontextprotocol/core';
import {
    CallToolRequestSchema,
    CallToolResultSchema,
    ClientCapabilitiesSchema,
    CreateMessageResultSchema,
    CreateMessageResultWithToolsSchema,
    CreateTaskResultSchema,
    ElicitResultSchema,
    EmptyResultSchema,
    LATEST_PROTOCOL_VERSION,
    ListRootsResultSchema,
    LoggingLevelSchema,
    mergeCapabilities,
    parseSchema,
    Protocol,
    ProtocolError,
    ProtocolErrorCode,
    SdkError,
    SdkErrorCode
} from '@modelcontextprotocol/core';
import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/server/_shims';

/** Three-arg send used by `_createMessageVia`/`_elicitInputVia`; satisfied by both `_requestWithSchema` and `ctx.mcpReq.send`. */
type SendWithSchema = <T extends StandardSchemaV1>(
    request: { method: string; params?: Record<string, unknown> },
    resultSchema: T,
    options?: RequestOptions
) => Promise<StandardSchemaV1.InferOutput<T>>;

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
     * @default {@linkcode DefaultJsonSchemaValidator} ({@linkcode index.AjvJsonSchemaValidator | AjvJsonSchemaValidator} on Node.js, `CfWorkerJsonSchemaValidator` on Cloudflare Workers)
     */
    jsonSchemaValidator?: jsonSchemaValidator;

    /**
     * Optional `ttl` (in seconds) included on `tools/list`, `prompts/list`, `resources/list`,
     * and `resources/templates/list` responses (SEP-2549). Tells clients how long the response
     * may be considered fresh; clients may cache and re-poll on this schedule. Supplements, does
     * not replace, the `list_changed` notification mechanism.
     */
    listTtlSeconds?: number;
};

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

    protected override buildContext(ctx: BaseContext, transportInfo?: MessageExtraInfo): ServerContext {
        // Only create http when there's actual HTTP transport info or auth info
        const hasHttpInfo = ctx.http || transportInfo?.request || transportInfo?.closeSSEStream || transportInfo?.closeStandaloneSSEStream;
        const sendOpts = (options?: RequestOptions): RequestOptions => ({ ...options, relatedRequestId: ctx.mcpReq.id });
        // SEP-2575: prefer per-request peer scope (lifted from `_meta` by S4) over the
        // singleton handshake state. Falls back to the singleton for the connect() path.
        // Normalize the per-request value: it may arrive raw from a transport adapter
        // (e.g. SessionCompat stores `initialize.params.capabilities` off the wire), and
        // ElicitationCapabilitySchema's preprocess (e.g. `{}` -> `{form:{}}`) must run
        // before the `_elicitInputVia` capability gate reads `caps.elicitation.form`.
        const rawReqCaps = ctx.mcpReq.clientCapabilities;
        const reqCaps =
            rawReqCaps === undefined ? this._clientCapabilities : (ClientCapabilitiesSchema.safeParse(rawReqCaps).data ?? rawReqCaps);
        const reqLogLevel = ctx.mcpReq.logLevel;
        return {
            ...ctx,
            mcpReq: {
                ...ctx.mcpReq,
                log: async (level, data, logger) => {
                    if (this._capabilities.logging && !this.isMessageIgnored(level, ctx.sessionId, reqLogLevel)) {
                        await ctx.mcpReq.notify({ method: 'notifications/message', params: { level, data, logger } });
                    }
                },
                elicitInput: (params, options) => this._elicitInputVia(ctx.mcpReq.send, reqCaps, params, sendOpts(options)),
                requestSampling: (params, options) => this._createMessageVia(ctx.mcpReq.send, reqCaps, params, sendOpts(options))
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
    private isMessageIgnored = (level: LoggingLevel, sessionId?: string, requestLevel?: LoggingLevel): boolean => {
        // SEP-2575: per-request `_meta.logLevel` (S4) takes precedence over session-stored level.
        const currentLevel = requestLevel ?? this._loggingLevels.get(sessionId);
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

            // SEP-2663: a tool may return a task envelope instead of a direct result.
            const resultSchema =
                (result as { resultType?: unknown } | undefined)?.resultType === 'task' ? CreateTaskResultSchema : CallToolResultSchema;
            const validationResult = parseSchema(resultSchema, result);
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

        const protocolVersion = this._supportedProtocolVersions.includes(requestedVersion)
            ? requestedVersion
            : (this._supportedProtocolVersions[0] ?? LATEST_PROTOCOL_VERSION);

        this.transport?.setProtocolVersion?.(protocolVersion);

        return { protocolVersion, ...this._ondiscover() };
    }

    /**
     * SEP-2575 `server/discover` handler. Returns capabilities, server info and instructions
     * without negotiating a protocol version (the client asserts the version per request via
     * `_meta`). Stateless: writes no instance fields, so one Server can serve unlimited
     * concurrent stateless clients on the dispatch() path.
     */
    private _ondiscover(): ServerDiscoverResult {
        return {
            capabilities: this.getCapabilities(),
            serverInfo: this._serverInfo,
            ...(this._instructions && { instructions: this._instructions })
        };
    }

    /**
     * After initialization has completed, this will be populated with the client's reported capabilities.
     */
    getClientCapabilities(): ClientCapabilities | undefined {
        return this._clientCapabilities;
    }

    /**
     * After initialization has completed, this will be populated with information about the client's name and version.
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
     *
     * @deprecated SEP-2577 deprecates the MCP Sampling feature (advisory; no wire change).
     */
    async createMessage(params: CreateMessageRequestParamsBase, options?: RequestOptions): Promise<CreateMessageResult>;

    /**
     * Request LLM sampling from the client with tool support.
     * Returns content that may be a single block or array (for parallel tool calls).
     *
     * @deprecated SEP-2577 deprecates the MCP Sampling feature (advisory; no wire change).
     */
    async createMessage(params: CreateMessageRequestParamsWithTools, options?: RequestOptions): Promise<CreateMessageResultWithTools>;

    /**
     * Request LLM sampling from the client.
     * When tools may or may not be present, returns the union type.
     *
     * @deprecated SEP-2577 deprecates the MCP Sampling feature (advisory; no wire change).
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
        return this._createMessageVia(
            (r, schema, opts) => this._requestWithSchema(r, schema, opts),
            this._clientCapabilities,
            params,
            options
        );
    }

    /**
     * Shared body for {@linkcode createMessage} and `ctx.mcpReq.requestSampling`: capability check,
     * tool_use/tool_result pairing validation, and result-schema selection. The `send` argument
     * routes to either the connected driver (instance method) or `ctx.mcpReq.send` (per-request).
     *
     * NOTE: the capability check below reads `this._clientCapabilities`, which is a singleton
     * (set on the most recent `initialize`). For multi-session `handleHttp` deployments this
     * can read a different session's caps. The per-request `_meta.clientCapabilities` flow
     * fixes this in a follow-up; until then, do not rely on the cap gate for isolation.
     */
    private async _createMessageVia(
        send: SendWithSchema,
        caps: ClientCapabilities | undefined,
        params: CreateMessageRequest['params'],
        options?: RequestOptions
    ): Promise<CreateMessageResult | CreateMessageResultWithTools> {
        // Base `sampling` capability is checked via assertCapabilityForMethod() (gated on
        // enforceStrictCapabilities, which defaults to false). Only the `sampling.tools`
        // sub-capability is enforced here unconditionally, matching the v1 createMessage body.
        if ((params.tools || params.toolChoice) && !caps?.sampling?.tools) {
            throw new SdkError(SdkErrorCode.CapabilityNotSupported, 'Client does not support sampling tools capability.');
        }

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

        if (params.tools) {
            return send({ method: 'sampling/createMessage', params }, CreateMessageResultWithToolsSchema, options);
        }
        return send({ method: 'sampling/createMessage', params }, CreateMessageResultSchema, options);
    }

    /**
     * Creates an elicitation request for the given parameters.
     * For backwards compatibility, `mode` may be omitted for form requests and will default to `"form"`.
     * @param params The parameters for the elicitation request.
     * @param options Optional request options.
     * @returns The result of the elicitation request.
     */
    async elicitInput(params: ElicitRequestFormParams | ElicitRequestURLParams, options?: RequestOptions): Promise<ElicitResult> {
        return this._elicitInputVia(
            (r, schema, opts) => this._requestWithSchema(r, schema, opts),
            this._clientCapabilities,
            params,
            options
        );
    }

    /**
     * Shared body for {@linkcode elicitInput} and `ctx.mcpReq.elicitInput`: form/url capability
     * sub-field check, mode defaulting, and post-receipt JSON-schema validation of `content`.
     */
    private async _elicitInputVia(
        send: SendWithSchema,
        caps: ClientCapabilities | undefined,
        params: ElicitRequestFormParams | ElicitRequestURLParams,
        options?: RequestOptions
    ): Promise<ElicitResult> {
        const mode = (params.mode ?? 'form') as 'form' | 'url';

        switch (mode) {
            case 'url': {
                if (!caps?.elicitation?.url) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, 'Client does not support url elicitation.');
                }
                const urlParams = params as ElicitRequestURLParams;
                return send({ method: 'elicitation/create', params: urlParams }, ElicitResultSchema, options);
            }
            case 'form': {
                if (!caps?.elicitation?.form) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, 'Client does not support form elicitation.');
                }
                const formParams: ElicitRequestFormParams =
                    params.mode === 'form' ? (params as ElicitRequestFormParams) : { ...(params as ElicitRequestFormParams), mode: 'form' };

                const result = await send({ method: 'elicitation/create', params: formParams }, ElicitResultSchema, options);

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
                        if (error instanceof ProtocolError) throw error;
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

    /**
     * Request the client's filesystem roots.
     *
     * @deprecated SEP-2577 deprecates the MCP Roots feature (advisory; no wire change).
     * Prefer passing scope via tool parameters or server configuration.
     */
    async listRoots(params?: ListRootsRequest['params'], options?: RequestOptions) {
        return this._requestWithSchema({ method: 'roots/list', params }, ListRootsResultSchema, options);
    }

    /**
     * Sends a logging message to the client, if connected.
     * Note: You only need to send the parameters object, not the entire JSON-RPC message.
     * @see {@linkcode LoggingMessageNotification}
     * @param params
     * @param sessionId Optional for stateless transports and backward compatibility.
     *
     * @deprecated SEP-2577 deprecates the MCP Logging feature (advisory; no wire change).
     * Prefer stderr or OpenTelemetry for server diagnostics.
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
