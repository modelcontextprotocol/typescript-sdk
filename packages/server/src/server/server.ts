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
    Notification,
    NotificationMethod,
    NotificationOptions,
    NotificationTypeMap,
    ProtocolConfig,
    ProtocolOptions,
    RequestMethod,
    RequestOptions,
    RequestTypeMap,
    ResourceUpdatedNotification,
    Result,
    ResultTypeMap,
    ServerCapabilities,
    ServerContext,
    StandardSchemaV1,
    ToolResultContent,
    ToolUseContent,
    Transport
} from '@modelcontextprotocol/core';
import {
    CallToolResultSchema,
    CreateMessageResultSchema,
    CreateMessageResultWithToolsSchema,
    ElicitResultSchema,
    EmptyResultSchema,
    HandlerRegistry,
    LATEST_PROTOCOL_VERSION,
    ListRootsResultSchema,
    LoggingLevelSchema,
    parseSchema,
    Protocol,
    ProtocolError,
    ProtocolErrorCode,
    SdkError,
    SdkErrorCode
} from '@modelcontextprotocol/core';
import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/server/_shims';

import { HTTPVersionRoutingTransport } from './httpVersionRoutingTransport.js';

export type ServerOptions = ProtocolOptions & {
    capabilities?: ServerCapabilities;
    instructions?: string;
    jsonSchemaValidator?: jsonSchemaValidator;
    /**
     * Optional pre-built HandlerRegistry. When supplied (e.g., by Server wrapper),
     * LegacyServer will use this registry instead of creating its own.
     * @internal
     */
    registry?: HandlerRegistry<ServerContext, ServerCapabilities>;
};

// ---------------------------------------------------------------------------
// Standalone functions extracted from LegacyServer for use as callbacks
// ---------------------------------------------------------------------------

function assertServerHandlerCapability(method: string, capabilities: ServerCapabilities): void {
    switch (method) {
        case 'completion/complete': {
            if (!capabilities.completions) {
                throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support completions (required for ${method})`);
            }
            break;
        }

        case 'logging/setLevel': {
            if (!capabilities.logging) {
                throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support logging (required for ${method})`);
            }
            break;
        }

        case 'prompts/get':
        case 'prompts/list': {
            if (!capabilities.prompts) {
                throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support prompts (required for ${method})`);
            }
            break;
        }

        case 'resources/list':
        case 'resources/templates/list':
        case 'resources/read': {
            if (!capabilities.resources) {
                throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support resources (required for ${method})`);
            }
            break;
        }

        case 'tools/call':
        case 'tools/list': {
            if (!capabilities.tools) {
                throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support tools (required for ${method})`);
            }
            break;
        }

        case 'ping':
        case 'initialize': {
            break;
        }
    }
}

function serverWrapHandler(
    method: string,
    handler: (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result>
): (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result> {
    if (method !== 'tools/call') {
        return handler;
    }
    return async (request, ctx) => {
        const result = await handler(request, ctx);

        const validationResult = parseSchema(CallToolResultSchema, result);
        if (!validationResult.success) {
            const errorMessage = validationResult.error instanceof Error ? validationResult.error.message : String(validationResult.error);
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid tools/call result: ${errorMessage}`);
        }

        return validationResult.data;
    };
}

/**
 * Creates a server HandlerRegistry with server-specific callbacks.
 * @internal
 */
export function createServerRegistry(capabilities?: ServerCapabilities): HandlerRegistry<ServerContext, ServerCapabilities> {
    const registry = new HandlerRegistry<ServerContext, ServerCapabilities>({
        capabilities,
        assertRequestHandlerCapability: method => assertServerHandlerCapability(method, registry.getCapabilities()),
        wrapHandler: serverWrapHandler
    });
    return registry;
}

/**
 * The Protocol-based MCP server implementation. Handles JSON-RPC dispatch,
 * request/response correlation, and bidirectional session management.
 *
 * Used internally by {@linkcode Server} for legacy transport connections and
 * by the routing transport for per-session legacy stacks.
 */
export class LegacyServer extends Protocol<ServerContext> {
    private _clientCapabilities?: ClientCapabilities;
    private _clientVersion?: Implementation;
    private _instructions?: string;
    private _serverInfo: Implementation;
    private _jsonSchemaValidator: jsonSchemaValidator;

    oninitialized?: () => void;

    constructor(serverInfo: Implementation, options?: ServerOptions) {
        const registry = options?.registry ?? createServerRegistry(options?.capabilities);
        super(registry, options);
        this._serverInfo = serverInfo;
        this._instructions = options?.instructions;
        this._jsonSchemaValidator = options?.jsonSchemaValidator ?? new DefaultJsonSchemaValidator();

        // Only register default handlers if they haven't been registered already
        // (e.g., the Server wrapper may have pre-populated the shared registry)
        if (!this._registry.requestHandlers.has('initialize')) {
            this.setRequestHandler('initialize', request => this._oninitialize(request));
        }
        if (!this._registry.notificationHandlers.has('notifications/initialized')) {
            this.setNotificationHandler('notifications/initialized', () => this.oninitialized?.());
        }

        if (this._registry.getCapabilities().logging) {
            this._registerLoggingHandler();
        }
    }

    getProtocolConfig(): ProtocolConfig {
        return {
            requestHandlers: this._registry.requestHandlers,
            serverInfo: this._serverInfo,
            capabilities: this._registry.getCapabilities(),
            instructions: this._instructions,
            createServer: () =>
                new LegacyServer(this._serverInfo, {
                    capabilities: this._registry.getCapabilities(),
                    instructions: this._instructions
                })
        };
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
        const hasHttpInfo = ctx.http || transportInfo?.request || transportInfo?.closeSSEStream || transportInfo?.closeStandaloneSSEStream;
        return {
            ...ctx,
            mcpReq: {
                ...ctx.mcpReq,
                log: (level, data, logger) => this.sendLoggingMessage({ level, data, logger }),
                elicitInput: (params, options) => this.elicitInput(params, options),
                requestSampling: (params, options) => this.createMessage(params, options)
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

    private _loggingLevels = new Map<string | undefined, LoggingLevel>();
    private readonly LOG_LEVEL_SEVERITY = new Map(LoggingLevelSchema.options.map((level, index) => [level, index]));

    private isMessageIgnored = (level: LoggingLevel, sessionId?: string): boolean => {
        const currentLevel = this._loggingLevels.get(sessionId);
        return currentLevel ? this.LOG_LEVEL_SEVERITY.get(level)! < this.LOG_LEVEL_SEVERITY.get(currentLevel)! : false;
    };

    public registerCapabilities(capabilities: ServerCapabilities): void {
        if (this.transport) {
            throw new SdkError(SdkErrorCode.AlreadyConnected, 'Cannot register capabilities after connecting to transport');
        }
        const hadLogging = !!this._registry.getCapabilities().logging;
        this._registry.registerCapabilities(capabilities);
        if (!hadLogging && this._registry.getCapabilities().logging) {
            this._registerLoggingHandler();
        }
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
                break;
            }
        }
    }

    protected assertNotificationCapability(method: NotificationMethod | string): void {
        switch (method) {
            case 'notifications/message': {
                if (!this._registry.getCapabilities().logging) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support logging (required for ${method})`);
                }
                break;
            }

            case 'notifications/resources/updated':
            case 'notifications/resources/list_changed': {
                if (!this._registry.getCapabilities().resources) {
                    throw new SdkError(
                        SdkErrorCode.CapabilityNotSupported,
                        `Server does not support notifying about resources (required for ${method})`
                    );
                }
                break;
            }

            case 'notifications/tools/list_changed': {
                if (!this._registry.getCapabilities().tools) {
                    throw new SdkError(
                        SdkErrorCode.CapabilityNotSupported,
                        `Server does not support notifying of tool list changes (required for ${method})`
                    );
                }
                break;
            }

            case 'notifications/prompts/list_changed': {
                if (!this._registry.getCapabilities().prompts) {
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

            case 'notifications/cancelled':
            case 'notifications/progress': {
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

        return {
            protocolVersion,
            capabilities: this.getCapabilities(),
            serverInfo: this._serverInfo,
            ...(this._instructions && { instructions: this._instructions })
        };
    }

    getClientCapabilities(): ClientCapabilities | undefined {
        return this._clientCapabilities;
    }

    getClientVersion(): Implementation | undefined {
        return this._clientVersion;
    }

    public getCapabilities(): ServerCapabilities {
        return this._registry.getCapabilities();
    }

    async ping() {
        return this._requestWithSchema({ method: 'ping' }, EmptyResultSchema);
    }

    async createMessage(params: CreateMessageRequestParamsBase, options?: RequestOptions): Promise<CreateMessageResult>;
    async createMessage(params: CreateMessageRequestParamsWithTools, options?: RequestOptions): Promise<CreateMessageResultWithTools>;
    async createMessage(
        params: CreateMessageRequest['params'],
        options?: RequestOptions
    ): Promise<CreateMessageResult | CreateMessageResultWithTools>;
    async createMessage(
        params: CreateMessageRequest['params'],
        options?: RequestOptions
    ): Promise<CreateMessageResult | CreateMessageResultWithTools> {
        if ((params.tools || params.toolChoice) && !this._clientCapabilities?.sampling?.tools) {
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
            return this._requestWithSchema({ method: 'sampling/createMessage', params }, CreateMessageResultWithToolsSchema, options);
        }
        return this._requestWithSchema({ method: 'sampling/createMessage', params }, CreateMessageResultSchema, options);
    }

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
                    params: { elicitationId }
                },
                options
            );
    }

    async listRoots(params?: ListRootsRequest['params'], options?: RequestOptions) {
        return this._requestWithSchema({ method: 'roots/list', params }, ListRootsResultSchema, options);
    }

    async sendLoggingMessage(params: LoggingMessageNotification['params'], sessionId?: string) {
        if (this._registry.getCapabilities().logging && !this.isMessageIgnored(params.level, sessionId)) {
            return this.notification({ method: 'notifications/message', params });
        }
    }

    async sendResourceUpdated(params: ResourceUpdatedNotification['params']) {
        return this.notification({ method: 'notifications/resources/updated', params });
    }

    async sendResourceListChanged() {
        return this.notification({ method: 'notifications/resources/list_changed' });
    }

    async sendToolListChanged() {
        return this.notification({ method: 'notifications/tools/list_changed' });
    }

    async sendPromptListChanged() {
        return this.notification({ method: 'notifications/prompts/list_changed' });
    }
}

/**
 * An MCP server on top of a pluggable transport.
 *
 * Owns a {@linkcode HandlerRegistry} directly for handler registration and
 * capability management. For routing transports, passes registry and config
 * directly. For regular transports, creates a {@linkcode LegacyServer} that
 * shares the same registry.
 */
export class Server {
    private _registry: HandlerRegistry<ServerContext, ServerCapabilities>;
    private _impl?: LegacyServer;
    private _transport?: Transport;
    private _serverInfo: Implementation;
    private _instructions?: string;
    private _options?: ServerOptions;

    oninitialized?: () => void;
    onclose?: () => void;
    onerror?: (error: Error) => void;

    get fallbackRequestHandler() {
        return this._registry.fallbackRequestHandler;
    }
    set fallbackRequestHandler(h) {
        this._registry.fallbackRequestHandler = h;
    }

    constructor(serverInfo: Implementation, options?: ServerOptions) {
        this._serverInfo = serverInfo;
        this._instructions = options?.instructions;
        this._options = options;

        this._registry = createServerRegistry(options?.capabilities);
    }

    private _createLegacyServer(): LegacyServer {
        return new LegacyServer(this._serverInfo, {
            ...this._options,
            registry: this._registry
        });
    }

    async connect(transport: Transport): Promise<void> {
        this._transport = transport;

        if (transport instanceof HTTPVersionRoutingTransport) {
            transport.setProtocolConfig({
                requestHandlers: this._registry.requestHandlers,
                serverInfo: this._serverInfo,
                capabilities: this._registry.getCapabilities(),
                instructions: this._instructions,
                createServer: () => this._createLegacyServer()
            });
            await transport.start();
        } else {
            this._impl = this._createLegacyServer();
            if (this.oninitialized) this._impl.oninitialized = this.oninitialized;
            if (this.onclose) this._impl.onclose = this.onclose;
            if (this.onerror) this._impl.onerror = this.onerror;
            await this._impl.connect(transport);
        }
    }

    async close(): Promise<void> {
        await (this._impl?.transport ? this._impl.close() : this._transport?.close());
    }

    get transport(): Transport | undefined {
        return this._impl?.transport ?? this._transport;
    }

    // Handler registration — delegates to shared registry
    setRequestHandler<M extends RequestMethod>(
        method: M,
        handler: (request: RequestTypeMap[M], ctx: ServerContext) => ResultTypeMap[M] | Promise<ResultTypeMap[M]>
    ): void;
    setRequestHandler<P extends StandardSchemaV1, R extends StandardSchemaV1 | undefined = undefined>(
        method: string,
        schemas: { params: P; result?: R },
        handler: (
            params: StandardSchemaV1.InferOutput<P>,
            ctx: ServerContext
        ) =>
            | (R extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<R> : Result)
            | Promise<R extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<R> : Result>
    ): void;
    setRequestHandler(method: string, ...args: unknown[]): void {
        (this._registry.setRequestHandler as (...a: unknown[]) => void).call(this._registry, method, ...args);
    }

    setNotificationHandler<M extends NotificationMethod>(
        method: M,
        handler: (notification: NotificationTypeMap[M]) => void | Promise<void>
    ): void;
    setNotificationHandler<P extends StandardSchemaV1>(
        method: string,
        schemas: { params: P },
        handler: (params: StandardSchemaV1.InferOutput<P>, notification: Notification) => void | Promise<void>
    ): void;
    setNotificationHandler(method: string, ...args: unknown[]): void {
        (this._registry.setNotificationHandler as (...a: unknown[]) => void).call(this._registry, method, ...args);
    }

    removeRequestHandler(method: RequestMethod | string): void {
        this._registry.removeRequestHandler(method);
    }

    removeNotificationHandler(method: NotificationMethod | string): void {
        this._registry.removeNotificationHandler(method);
    }

    assertCanSetRequestHandler(method: RequestMethod | string): void {
        this._registry.assertCanSetRequestHandler(method);
    }

    registerCapabilities(capabilities: ServerCapabilities): void {
        if (this._impl?.transport || this._transport) {
            throw new SdkError(SdkErrorCode.AlreadyConnected, 'Cannot register capabilities after connecting to transport');
        }
        this._registry.registerCapabilities(capabilities);
    }

    getCapabilities(): ServerCapabilities {
        return this._registry.getCapabilities();
    }

    getClientCapabilities(): ClientCapabilities | undefined {
        return this._impl?.getClientCapabilities();
    }

    getClientVersion(): Implementation | undefined {
        return this._impl?.getClientVersion();
    }

    // Server-to-client methods — only work when connected to a regular transport
    async createMessage(params: CreateMessageRequestParamsBase, options?: RequestOptions): Promise<CreateMessageResult>;
    async createMessage(params: CreateMessageRequestParamsWithTools, options?: RequestOptions): Promise<CreateMessageResultWithTools>;
    async createMessage(
        params: CreateMessageRequest['params'],
        options?: RequestOptions
    ): Promise<CreateMessageResult | CreateMessageResultWithTools>;
    async createMessage(
        params: CreateMessageRequest['params'],
        options?: RequestOptions
    ): Promise<CreateMessageResult | CreateMessageResultWithTools> {
        if (!this._impl) throw new Error('Not connected to a legacy transport');
        return this._impl.createMessage(params, options);
    }

    async elicitInput(params: ElicitRequestFormParams | ElicitRequestURLParams, options?: RequestOptions): Promise<ElicitResult> {
        if (!this._impl) throw new Error('Not connected to a legacy transport');
        return this._impl.elicitInput(params, options);
    }

    createElicitationCompletionNotifier(elicitationId: string, options?: NotificationOptions): () => Promise<void> {
        if (!this._impl?.getClientCapabilities()?.elicitation?.url) {
            throw new SdkError(
                SdkErrorCode.CapabilityNotSupported,
                'Client does not support URL elicitation (required for notifications/elicitation/complete)'
            );
        }
        return () =>
            this.notification(
                {
                    method: 'notifications/elicitation/complete',
                    params: { elicitationId }
                },
                options
            );
    }

    async listRoots(params?: ListRootsRequest['params'], options?: RequestOptions) {
        if (!this._impl) throw new Error('Not connected to a legacy transport');
        return this._impl.listRoots(params, options);
    }

    async ping() {
        if (!this._impl) throw new Error('Not connected to a legacy transport');
        return this._impl.ping();
    }

    request<M extends RequestMethod>(
        request: { method: M; params?: Record<string, unknown> },
        options?: RequestOptions
    ): Promise<ResultTypeMap[M]>;
    request<T extends StandardSchemaV1>(
        request: { method: string; params?: Record<string, unknown> },
        resultSchema: T,
        options?: RequestOptions
    ): Promise<StandardSchemaV1.InferOutput<T>>;
    request(request: { method: string; params?: Record<string, unknown> }, ...args: unknown[]): Promise<unknown> {
        if (!this._impl) throw new Error('Not connected to a legacy transport');
        return (this._impl.request as (...a: unknown[]) => Promise<unknown>).call(this._impl, request, ...args);
    }

    async notification(notification: Notification, options?: NotificationOptions): Promise<void> {
        if (!this._impl) throw new Error('Not connected to a legacy transport');
        return this._impl.notification(notification, options);
    }

    async sendLoggingMessage(params: LoggingMessageNotification['params'], sessionId?: string) {
        if (!this._impl) throw new Error('Not connected to a legacy transport');
        return this._impl.sendLoggingMessage(params, sessionId);
    }

    async sendResourceUpdated(params: ResourceUpdatedNotification['params']) {
        if (!this._impl) throw new Error('Not connected to a legacy transport');
        return this._impl.sendResourceUpdated(params);
    }

    async sendResourceListChanged() {
        if (!this._impl) throw new Error('Not connected to a legacy transport');
        return this._impl.sendResourceListChanged();
    }

    async sendToolListChanged() {
        if (!this._impl) throw new Error('Not connected to a legacy transport');
        return this._impl.sendToolListChanged();
    }

    async sendPromptListChanged() {
        if (!this._impl) throw new Error('Not connected to a legacy transport');
        return this._impl.sendPromptListChanged();
    }
}
