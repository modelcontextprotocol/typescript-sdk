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
    JSONRPCErrorResponse,
    JSONRPCRequest,
    JSONRPCResponse,
    JsonSchemaType,
    jsonSchemaValidator,
    ListRootsRequest,
    LoggingLevel,
    LoggingMessageNotification,
    MessageExtraInfo,
    Middleware,
    NotificationMethod,
    NotificationOptions,
    ProtocolOptions,
    RequestMethod,
    RequestOptions,
    ServerCapabilities,
    ServerContext,
    ToolResultContent,
    ToolUseContent
} from '@modelcontextprotocol/core';
import {
    CallToolRequestSchema,
    CallToolResultSchema,
    CreateMessageResultSchema,
    CreateMessageResultWithToolsSchema,
    ElicitResultSchema,
    EmptyResultSchema,
    isInputRequiredError,
    isStatelessProtocolVersion,
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

import type { SubscriptionBackend } from './subscriptions.js';

const LOG_LEVEL_SEVERITY = new Map(LoggingLevelSchema.options.map((level, index) => [level, index]));

/**
 * Returns true when `level` is at least as severe as `threshold`.
 * Lower index in `LoggingLevelSchema.options` is more verbose.
 */
export function severityAtLeast(level: LoggingLevel, threshold: LoggingLevel): boolean {
    return (LOG_LEVEL_SEVERITY.get(level) ?? 0) >= (LOG_LEVEL_SEVERITY.get(threshold) ?? 0);
}

/**
 * Throws if the given sampling params require a client sub-capability the
 * client did not declare. Shared by the legacy `createMessage` path and the
 * stateless `ctx.mcpReq.requestSampling` path so the handler-facing call has
 * the same semantics under both protocols.
 */
export function assertSamplingCapability(params: CreateMessageRequest['params'], clientCapabilities: ClientCapabilities | undefined): void {
    if ((params.tools || params.toolChoice) && !clientCapabilities?.sampling?.tools) {
        throw new SdkError(SdkErrorCode.CapabilityNotSupported, 'Client does not support sampling tools capability.');
    }
}

/**
 * Validates `tool_use`/`tool_result` pairing in sampling messages. These may
 * appear even without `tools`/`toolChoice` in the current request when a prior
 * sampling request returned `tool_use` and this is a follow-up with results.
 */
export function assertSamplingMessagePairing(params: CreateMessageRequest['params']): void {
    if (params.messages.length === 0) return;
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
        const toolResultIds = new Set(lastContent.filter(c => c.type === 'tool_result').map(c => (c as ToolResultContent).toolUseId));
        if (toolUseIds.size !== toolResultIds.size || ![...toolUseIds].every(id => toolResultIds.has(id))) {
            throw new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                'ids of tool_result blocks and tool_use blocks from previous message do not match'
            );
        }
    }
}

/**
 * Throws if the given elicitation params require a client sub-capability the
 * client did not declare. Shared by the legacy `elicitInput` path and the
 * stateless `ctx.mcpReq.elicitInput` path.
 */
export function assertElicitCapability(
    params: ElicitRequestFormParams | ElicitRequestURLParams,
    clientCapabilities: ClientCapabilities | undefined
): void {
    const mode = (params.mode ?? 'form') as 'form' | 'url';
    if (mode === 'url' && !clientCapabilities?.elicitation?.url) {
        throw new SdkError(SdkErrorCode.CapabilityNotSupported, 'Client does not support url elicitation.');
    }
    if (mode === 'form' && !clientCapabilities?.elicitation?.form) {
        throw new SdkError(SdkErrorCode.CapabilityNotSupported, 'Client does not support form elicitation.');
    }
}

/**
 * Validates a form-mode elicitation result's `content` against the request's
 * `requestedSchema`. Throws on schema or validation failure.
 */
export function validateElicitFormContent(
    validator: jsonSchemaValidator,
    params: ElicitRequestFormParams | ElicitRequestURLParams,
    result: ElicitResult
): void {
    const mode = params.mode ?? 'form';
    if (mode !== 'form' || result.action !== 'accept' || !result.content) return;
    const formParams = params as ElicitRequestFormParams;
    if (!formParams.requestedSchema) return;
    try {
        const v = validator.getValidator(formParams.requestedSchema as JsonSchemaType);
        const validationResult = v(result.content);
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

/**
 * Dispatcher middleware that catches `InputRequiredError`, gates
 * against `ctx.clientCapabilities`, and translates to an `InputRequiredResult`.
 *
 * Runs on both dispatch paths but only the stateless ctx-builder installs the
 * MRTR `elicitInput`/`requestSampling` shims that throw `InputRequiredError`;
 * legacy `ctx.mcpReq.elicitInput`/`requestSampling` send real requests, so the
 * catch never fires on the legacy path.
 *
 * MRTR via `InputRequiredError` works for handlers registered via
 * `setRequestHandler`; `fallbackRequestHandler` is not wrapped by middleware
 * (matches pre-existing behavior).
 */
export const inputRequiredMiddleware: Middleware<ServerContext> = async (_request, ctx, next) => {
    try {
        return await next();
    } catch (error) {
        if (!isInputRequiredError(error)) throw error;
        const caps = ctx.clientCapabilities as Record<string, unknown> | undefined;
        const missing = error.requiredCapabilities().filter(c => !caps?.[c]);
        if (missing.length > 0) {
            // Spec: data.requiredCapabilities is a (partial) ClientCapabilities
            // object, not a string array.
            const requiredCapabilities: ClientCapabilities = {};
            for (const c of missing) (requiredCapabilities as Record<string, object>)[c] = {};
            throw new ProtocolError(ProtocolErrorCode.MissingRequiredClientCapability, 'Missing required client capability', {
                requiredCapabilities
            });
        }
        return {
            resultType: 'input_required',
            inputRequests: error.inputRequests,
            ...(error.requestState === undefined ? {} : { requestState: error.requestState })
        };
    }
};

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
     * Backend for `subscriptions/listen`. Defaults to `InMemorySubscriptions`.
     * Supply a distributed implementation for horizontally-scaled deployments.
     */
    subscriptions?: SubscriptionBackend;
};

/**
 * An MCP server on top of a pluggable transport.
 *
 * This server will automatically respond to the initialization flow as initiated from the client.
 *
 * @deprecated Use {@linkcode server/mcp.McpServer | McpServer} instead for the high-level API. Only use `Server` for advanced use cases.
 */
export class LegacyServer extends Protocol<ServerContext> {
    private _clientCapabilities?: ClientCapabilities;
    private _clientVersion?: Implementation;
    private _capabilities: ServerCapabilities;
    private _instructions?: string;
    private _jsonSchemaValidator: jsonSchemaValidator;

    /**
     * Callback for when initialization has fully completed (i.e., the client has sent an `notifications/initialized` notification).
     *
     * @deprecated A 2026-06 client never sends `notifications/initialized`. This callback fires only when a pre-2026 client connects.
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

        this.dispatcher.use(inputRequiredMiddleware);
        this.dispatcher.use(LegacyServer._callToolResultMiddleware);

        this.setRequestHandler('initialize', request => this._oninitialize(request));
        this.setNotificationHandler('notifications/initialized', () => this.oninitialized?.());

        if (this._capabilities.logging) {
            this._registerLoggingHandler();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // internal — exposed for the composing Server (server.ts)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @internal Routes a request through this instance's `Dispatcher`.
     * Called by `Server._dispatchStateless` so both the legacy `_onrequest`
     * path and the 2026 stateless path share one registry + middleware chain.
     */
    _dispatch(request: JSONRPCRequest, ctx: ServerContext): Promise<JSONRPCResponse | JSONRPCErrorResponse> {
        return this.dispatcher.dispatch(request, ctx);
    }

    /** @internal Exposed so the composing `Server` can `dispatcher.use(...)`. */
    _useMiddleware(mw: Middleware<ServerContext>): void {
        this.dispatcher.use(mw);
    }

    /** @internal */
    get _validator(): jsonSchemaValidator {
        return this._jsonSchemaValidator;
    }

    /**
     * Throws when no session-based transport is connected. Guards the
     * pre-2026 server-to-client methods so callers get a directed migration
     * error instead of `NotConnected`.
     */
    private _assertSession(via: string): void {
        if (!this.transport) {
            throw new SdkError(
                SdkErrorCode.SessionRequired,
                `${this.constructor.name}.${via} requires a connected pre-2026 session; use ${via} inside a handler instead. ` +
                    'See https://modelcontextprotocol.io/docs/migration#2026-06'
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // session-dependent (existing — bodies unchanged)
    //
    // These top-level methods need a connected pre-2026 client (initialize
    // handshake). The same capability is available per-request via
    // ctx.mcpReq.* / ctx.clientCapabilities under both protocols.
    // See Server._buildDispatchServerContext for the 2026 ctx shape.
    //
    //   _oninitialize           — 2026 equiv: Server._ondiscover
    //   createMessage           — 2026 equiv: ctx.mcpReq.requestSampling (MRTR)
    //   elicitInput             — 2026 equiv: ctx.mcpReq.elicitInput (MRTR)
    //   listRoots               — 2026 equiv: ctx.mcpReq.listRoots (MRTR)
    //   sendLoggingMessage      — 2026 equiv: ctx.mcpReq.log
    //   getClientCapabilities   — 2026 equiv: ctx.clientCapabilities (per-request from _meta)
    //   getClientVersion        — 2026 equiv: ctx.mcpReq._meta clientInfo
    //   ping                    — removed by 2026 spec (STATELESS_REMOVED_METHODS)
    //   buildContext            — legacy ctx builder; Server._buildDispatchServerContext is 2026's
    // ═══════════════════════════════════════════════════════════════════════

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
        return {
            ...ctx,
            clientCapabilities: this._clientCapabilities,
            mcpReq: {
                ...ctx.mcpReq,
                log: (level, data, logger) => this.sendLoggingMessage({ level, data, logger }),
                elicitInput: (params, options) => this.elicitInput(params, options),
                requestSampling: this.createMessage.bind(this),
                listRoots: (params, options) => this.listRoots(params, options)
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

    // Is a message with the given level ignored in the log level set for the given session id?
    private isMessageIgnored = (level: LoggingLevel, sessionId?: string): boolean => {
        const currentLevel = this._loggingLevels.get(sessionId);
        return currentLevel !== undefined && !severityAtLeast(level, currentLevel);
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
     * handler was registered. Installed as a {@linkcode Dispatcher} middleware so
     * it applies to both the legacy `_onrequest` path and the 2026-06 dispatch path.
     */
    private static readonly _callToolResultMiddleware: Middleware<ServerContext> = async (request, _ctx, next) => {
        if (request.method !== 'tools/call') {
            return next();
        }
        const validatedRequest = parseSchema(CallToolRequestSchema, request);
        if (!validatedRequest.success) {
            const errorMessage = validatedRequest.error instanceof Error ? validatedRequest.error.message : String(validatedRequest.error);
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid tools/call request: ${errorMessage}`);
        }
        const result = await next();
        const validationResult = parseSchema(CallToolResultSchema, result);
        if (!validationResult.success) {
            const errorMessage = validationResult.error instanceof Error ? validationResult.error.message : String(validationResult.error);
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid tools/call result: ${errorMessage}`);
        }
        return validationResult.data;
    };

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
            case 'initialize': {
                // No specific capability required for these methods
                break;
            }
        }
    }

    private async _oninitialize(request: InitializeRequest): Promise<InitializeResult> {
        const requestedVersion = request.params.protocolVersion;

        this._clientCapabilities = request.params.capabilities;
        this._clientVersion = request.params.clientInfo;

        // The legacy `initialize` handshake never agrees on a stateless (2026+)
        // version: a client that wants 2026 sends `server/discover`, not this.
        const legacySupported = this._supportedProtocolVersions.filter(v => !isStatelessProtocolVersion(v));
        const protocolVersion = legacySupported.includes(requestedVersion)
            ? requestedVersion
            : (legacySupported[0] ?? LATEST_PROTOCOL_VERSION);

        this.transport?.setProtocolVersion?.(protocolVersion);

        return {
            protocolVersion,
            capabilities: this.getCapabilities(),
            serverInfo: this._serverInfo,
            ...(this._instructions && { instructions: this._instructions })
        };
    }

    /**
     * After initialization has completed, this will be populated with the client's reported capabilities.
     *
     * @deprecated Use `ctx.clientCapabilities` inside a handler. Works under both protocols. This top-level form requires a pre-2026 connection.
     */
    getClientCapabilities(): ClientCapabilities | undefined {
        return this._clientCapabilities;
    }

    /**
     * After initialization has completed, this will be populated with information about the client's name and version.
     *
     * @deprecated Use `ctx.mcpReq._meta?.['io.modelcontextprotocol/clientInfo']` inside a handler. Works under both protocols. This top-level form requires a pre-2026 connection.
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

    /**
     * @deprecated `ping` is removed in the 2026-06 protocol. This top-level form requires a pre-2026 connection.
     */
    async ping() {
        this._assertSession('ping');
        return this._requestWithSchema({ method: 'ping' }, EmptyResultSchema);
    }

    /**
     * Request LLM sampling from the client (without tools).
     * Returns single content block for backwards compatibility.
     *
     * @deprecated Use `ctx.mcpReq.requestSampling(params)` inside a handler. Works under both protocols. This top-level form requires a pre-2026 connection.
     */
    async createMessage(params: CreateMessageRequestParamsBase, options?: RequestOptions): Promise<CreateMessageResult>;

    /**
     * Request LLM sampling from the client with tool support.
     * Returns content that may be a single block or array (for parallel tool calls).
     *
     * @deprecated Use `ctx.mcpReq.requestSampling(params)` inside a handler. Works under both protocols. This top-level form requires a pre-2026 connection.
     */
    async createMessage(params: CreateMessageRequestParamsWithTools, options?: RequestOptions): Promise<CreateMessageResultWithTools>;

    /**
     * Request LLM sampling from the client.
     * When tools may or may not be present, returns the union type.
     *
     * @deprecated Use `ctx.mcpReq.requestSampling(params)` inside a handler. Works under both protocols. This top-level form requires a pre-2026 connection.
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
        this._assertSession('createMessage (use ctx.mcpReq.requestSampling)');
        assertSamplingCapability(params, this._clientCapabilities);
        assertSamplingMessagePairing(params);

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
     * @deprecated Use `ctx.mcpReq.elicitInput(params)` inside a handler. Works under both protocols. This top-level form requires a pre-2026 connection.
     */
    async elicitInput(params: ElicitRequestFormParams | ElicitRequestURLParams, options?: RequestOptions): Promise<ElicitResult> {
        this._assertSession('elicitInput (use ctx.mcpReq.elicitInput)');
        assertElicitCapability(params, this._clientCapabilities);
        const mode = (params.mode ?? 'form') as 'form' | 'url';

        switch (mode) {
            case 'url': {
                const urlParams = params as ElicitRequestURLParams;
                return this._requestWithSchema({ method: 'elicitation/create', params: urlParams }, ElicitResultSchema, options);
            }
            case 'form': {
                const formParams: ElicitRequestFormParams =
                    params.mode === 'form' ? (params as ElicitRequestFormParams) : { ...(params as ElicitRequestFormParams), mode: 'form' };

                const result = await this._requestWithSchema(
                    { method: 'elicitation/create', params: formParams },
                    ElicitResultSchema,
                    options
                );

                validateElicitFormContent(this._jsonSchemaValidator, formParams, result);
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
     * @deprecated Use `ctx.mcpReq.listRoots()` inside a handler. Works under both protocols. This top-level form requires a pre-2026 connection.
     */
    async listRoots(params?: ListRootsRequest['params'], options?: RequestOptions) {
        this._assertSession('listRoots (use ctx.mcpReq.listRoots)');
        return this._requestWithSchema({ method: 'roots/list', params }, ListRootsResultSchema, options);
    }

    /**
     * Sends a logging message to the client, if connected.
     * Note: You only need to send the parameters object, not the entire JSON-RPC message.
     * @see {@linkcode LoggingMessageNotification}
     * @param params
     * @param sessionId Optional for stateless transports and backward compatibility.
     * @deprecated Use `ctx.mcpReq.log(level, data, logger?)` inside a handler. Works under both protocols. This top-level form requires a pre-2026 connection.
     */
    async sendLoggingMessage(params: LoggingMessageNotification['params'], sessionId?: string) {
        this._assertSession('sendLoggingMessage (use ctx.mcpReq.log)');
        if (this._capabilities.logging && !this.isMessageIgnored(params.level, sessionId)) {
            return this.notification({ method: 'notifications/message', params });
        }
    }
}
