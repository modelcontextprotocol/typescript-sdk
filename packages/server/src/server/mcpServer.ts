import type {
    AuthInfo,
    BaseContext,
    BaseMetadata,
    CallToolRequest,
    MessageExtraInfo,
    CallToolResult,
    ClientCapabilities,
    CompleteRequestPrompt,
    CompleteRequestResourceTemplate,
    CompleteResult,
    CreateMessageRequest,
    CreateMessageRequestParamsBase,
    CreateMessageRequestParamsWithTools,
    CreateMessageResult,
    CreateMessageResultWithTools,
    CreateTaskResult,
    CreateTaskServerContext,
    DispatchEnv,
    ElicitRequestFormParams,
    ElicitRequestURLParams,
    ElicitResult,
    GetPromptResult,
    Implementation,
    InitializeRequest,
    InitializeResult,
    JSONRPCMessage,
    JSONRPCRequest,
    JsonSchemaType,
    jsonSchemaValidator,
    ListPromptsResult,
    ListResourcesResult,
    ListRootsRequest,
    ListToolsResult,
    LoggingLevel,
    LoggingMessageNotification,
    Notification,
    NotificationMethod,
    NotificationOptions,
    Prompt,
    PromptReference,
    ProtocolOptions,
    ReadResourceResult,
    Request,
    RequestMethod,
    RequestOptions,
    RequestTypeMap,
    Resource,
    ResourceTemplateReference,
    ResourceUpdatedNotification,
    Result,
    ResultTypeMap,
    ServerCapabilities,
    ServerContext,
    ServerResult,
    StandardSchemaWithJSON,
    StreamDriverOptions,
    TaskManagerHost,
    TaskManagerOptions,
    Tool,
    ToolAnnotations,
    ToolExecution,
    ToolResultContent,
    ToolUseContent,
    Transport,
    Variables
} from '@modelcontextprotocol/core';
import {
    assertClientRequestTaskCapability,
    assertCompleteRequestPrompt,
    assertCompleteRequestResourceTemplate,
    assertToolsCallTaskCapability,
    CallToolRequestSchema,
    CallToolResultSchema,
    CreateMessageResultSchema,
    CreateMessageResultWithToolsSchema,
    CreateTaskResultSchema,
    Dispatcher,
    ElicitResultSchema,
    EmptyResultSchema,
    extractTaskManagerOptions,
    getResultSchema,
    isJSONRPCRequest,
    isStandardSchema,
    isStandardSchemaWithJSON,
    LATEST_PROTOCOL_VERSION,
    ListRootsResultSchema,
    LoggingLevelSchema,
    mergeCapabilities,
    NullTaskManager,
    parseSchema,
    promptArgumentsFromStandardSchema,
    ProtocolError,
    ProtocolErrorCode,
    SdkError,
    SdkErrorCode,
    standardSchemaToJsonSchema,
    StreamDriver,
    SUPPORTED_PROTOCOL_VERSIONS,
    TaskManager,
    UriTemplate,
    validateAndWarnToolName,
    validateStandardSchema
} from '@modelcontextprotocol/core';
import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/server/_shims';
import { z } from 'zod/v4';

import type { ToolTaskHandler } from '../experimental/tasks/interfaces.js';
import { ExperimentalMcpServerTasks } from '../experimental/tasks/mcpServer.js';
import { getCompleter, isCompletable } from './completable.js';

/**
 * Extended tasks capability that includes runtime configuration (store, messageQueue).
 * The runtime-only fields are stripped before advertising capabilities to clients.
 */
export type ServerTasksCapabilityWithRuntime = NonNullable<ServerCapabilities['tasks']> & TaskManagerOptions;

export type ServerOptions = Omit<ProtocolOptions, 'tasks'> & {
    /**
     * Capabilities to advertise as being supported by this server.
     */
    capabilities?: Omit<ServerCapabilities, 'tasks'> & {
        tasks?: ServerTasksCapabilityWithRuntime;
    };

    /**
     * Optional instructions describing how to use the server and its features.
     */
    instructions?: string;

    /**
     * JSON Schema validator for elicitation response validation.
     *
     * @default {@linkcode DefaultJsonSchemaValidator}
     */
    jsonSchemaValidator?: jsonSchemaValidator;
};

/**
 * MCP server. Holds tool/resource/prompt registries and exposes both a stateless
 * {@linkcode McpServer.handle | handle()} entry point (for HTTP/gRPC/serverless drivers)
 * and a {@linkcode McpServer.connect | connect()} entry point (for stdio/WebSocket pipes).
 *
 * One instance can serve any number of concurrent requests.
 */
export class McpServer extends Dispatcher<ServerContext> {
    private _driver?: StreamDriver;

    private _clientCapabilities?: ClientCapabilities;
    private _clientVersion?: Implementation;
    private _capabilities: ServerCapabilities;
    private _instructions?: string;
    private _jsonSchemaValidator: jsonSchemaValidator;
    private _supportedProtocolVersions: string[];
    private _experimental?: { tasks: ExperimentalMcpServerTasks };
    private _taskManager: TaskManager;
    private _loggingLevels = new Map<string | undefined, LoggingLevel>();
    private readonly LOG_LEVEL_SEVERITY = new Map(LoggingLevelSchema.options.map((level, index) => [level, index]));

    private _registeredResources: { [uri: string]: RegisteredResource } = {};
    private _registeredResourceTemplates: { [name: string]: RegisteredResourceTemplate } = {};
    private _registeredTools: { [name: string]: RegisteredTool } = {};
    private _registeredPrompts: { [name: string]: RegisteredPrompt } = {};

    private _toolHandlersInitialized = false;
    private _completionHandlerInitialized = false;
    private _resourceHandlersInitialized = false;
    private _promptHandlersInitialized = false;

    /**
     * Callback for when initialization has fully completed.
     */
    oninitialized?: () => void;

    /**
     * Callback for when a connected transport is closed.
     */
    onclose?: () => void;

    /**
     * Callback for when an error occurs.
     */
    onerror?: (error: Error) => void;

    constructor(
        private _serverInfo: Implementation,
        private _options?: ServerOptions
    ) {
        super();
        this._capabilities = _options?.capabilities ? { ..._options.capabilities } : {};
        this._instructions = _options?.instructions;
        this._jsonSchemaValidator = _options?.jsonSchemaValidator ?? new DefaultJsonSchemaValidator();
        this._supportedProtocolVersions = _options?.supportedProtocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS;

        // Strip runtime-only fields from advertised capabilities
        if (_options?.capabilities?.tasks) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { taskStore, taskMessageQueue, defaultTaskPollInterval, maxTaskQueueSize, ...wireCapabilities } =
                _options.capabilities.tasks;
            this._capabilities.tasks = wireCapabilities;
        }

        const tasksOpts = extractTaskManagerOptions(_options?.capabilities?.tasks);
        this._taskManager = tasksOpts ? new TaskManager(tasksOpts) : new NullTaskManager();
        this._bindTaskManager();

        this.setRequestHandler('initialize', request => this._oninitialize(request));
        this.setRequestHandler('ping', () => ({}));
        this.setNotificationHandler('notifications/initialized', () => this.oninitialized?.());

        if (this._capabilities.logging) {
            this._registerLoggingHandler();
        }
    }

    // ───────────────────────────────────────────────────────────────────────
    // Direct dispatch (Proposal 1)
    // ───────────────────────────────────────────────────────────────────────

    /**
     * Handle one inbound request without a transport. Yields any notifications the handler
     * emits via `ctx.mcpReq.notify()`, then yields exactly one terminal response.
     */
    async *handle(request: JSONRPCRequest, env?: DispatchEnv): AsyncGenerator<JSONRPCMessage, void, void> {
        for await (const out of this.dispatch(request, env)) {
            yield out.message;
        }
    }

    /**
     * Convenience entry for HTTP request/response drivers. Parses the body, dispatches each
     * request, and returns a JSON response. SSE streaming is handled by `shttpHandler`, not here.
     */
    async handleHttp(req: globalThis.Request, opts?: { authInfo?: AuthInfo }): Promise<Response> {
        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return jsonResponse(400, { jsonrpc: '2.0', id: null, error: { code: ProtocolErrorCode.ParseError, message: 'Parse error' } });
        }
        const messages = Array.isArray(body) ? body : [body];
        const env: DispatchEnv = { authInfo: opts?.authInfo, httpReq: req };
        const responses: JSONRPCMessage[] = [];
        for (const m of messages) {
            if (!isJSONRPCRequest(m)) {
                if (m && typeof m === 'object' && 'method' in m) {
                    await this.dispatchNotification(m).catch(() => {});
                }
                continue;
            }
            for await (const out of this.dispatch(m, env)) {
                if (out.kind === 'response') responses.push(out.message);
            }
        }
        if (responses.length === 0) return new Response(null, { status: 202 });
        return jsonResponse(200, responses.length === 1 ? responses[0] : responses);
    }

    // ───────────────────────────────────────────────────────────────────────
    // Persistent-pipe transport (compat: builds a StreamDriver)
    // ───────────────────────────────────────────────────────────────────────

    /**
     * Attaches to the given transport, starts it, and starts listening for messages.
     * Builds a {@linkcode StreamDriver} internally.
     */
    async connect(transport: Transport): Promise<void> {
        const driverOpts: StreamDriverOptions = {
            supportedProtocolVersions: this._supportedProtocolVersions,
            debouncedNotificationMethods: this._options?.debouncedNotificationMethods,
            taskManager: this._taskManager,
            enforceStrictCapabilities: this._options?.enforceStrictCapabilities,
            buildEnv: (extra, base) => ({ ...base, _transportExtra: extra })
        };
        const driver = new StreamDriver(this, transport, driverOpts);
        this._driver = driver;
        driver.onclose = () => {
            if (this._driver === driver) this._driver = undefined;
            this.onclose?.();
        };
        driver.onerror = error => this.onerror?.(error);
        await driver.start();
    }

    /**
     * Closes the connection.
     */
    async close(): Promise<void> {
        await this._driver?.close();
    }

    /**
     * Checks if the server is connected to a transport.
     */
    isConnected(): boolean {
        return this._driver !== undefined;
    }

    get transport(): Transport | undefined {
        return this._driver?.pipe;
    }

    /**
     * Returns this instance. Kept so v1 code that reaches `mcpServer.server.X` keeps working.
     * @deprecated Call methods directly on `McpServer`.
     */
    get server(): this {
        return this;
    }

    /**
     * Access experimental features.
     * @experimental
     */
    get experimental(): { tasks: ExperimentalMcpServerTasks } {
        if (!this._experimental) {
            this._experimental = { tasks: new ExperimentalMcpServerTasks(this) };
        }
        return this._experimental;
    }

    /** Task orchestration. Always available; a {@linkcode NullTaskManager} when no task store is configured. */
    get taskManager(): TaskManager {
        return this._taskManager;
    }

    private _bindTaskManager(): void {
        const host: TaskManagerHost = {
            request: (r, schema, opts) => this._driverRequest(r, schema as never, opts),
            notification: (n, opts) => this.notification(n, opts),
            reportError: e => (this.onerror ?? (() => {}))(e),
            removeProgressHandler: t => this._driver?.removeProgressHandler(t),
            registerHandler: (m, h) => this.setRawRequestHandler(m, h as never),
            sendOnResponseStream: async (msg, relatedRequestId) => {
                await this._driver?.pipe.send(msg, { relatedRequestId });
            },
            enforceStrictCapabilities: this._options?.enforceStrictCapabilities === true,
            assertTaskCapability: m => this._assertTaskCapability(m),
            assertTaskHandlerCapability: m => this._assertTaskHandlerCapability(m)
        };
        this._taskManager.bind(host);
    }

    // ───────────────────────────────────────────────────────────────────────
    // Context building
    // ───────────────────────────────────────────────────────────────────────

    protected override buildContext(base: BaseContext, env: DispatchEnv & { _transportExtra?: MessageExtraInfo }): ServerContext {
        const extra = env._transportExtra;
        const hasHttpInfo = base.http || env.httpReq || extra?.closeSSEStream || extra?.closeStandaloneSSEStream;
        const ctx: ServerContext = {
            ...base,
            mcpReq: {
                ...base.mcpReq,
                log: (level, data, logger) =>
                    base.mcpReq.notify({ method: 'notifications/message', params: { level, data, logger } }),
                elicitInput: (params, options) => this._elicitInputViaCtx(base, params, options),
                requestSampling: (params, options) => this._createMessageViaCtx(base, params, options)
            },
            http: hasHttpInfo
                ? {
                      ...base.http,
                      req: env.httpReq,
                      closeSSE: extra?.closeSSEStream,
                      closeStandaloneSSE: extra?.closeStandaloneSSEStream
                  }
                : undefined
        };
        // v1 RequestHandlerExtra flat compat fields. New code should use ctx.mcpReq.* / ctx.http.*.
        const compat = ctx as ServerContext & Record<string, unknown>;
        compat.signal = base.mcpReq.signal;
        compat.requestId = base.mcpReq.id;
        compat._meta = base.mcpReq._meta;
        compat.sendNotification = base.mcpReq.notify;
        compat.sendRequest = base.mcpReq.send;
        compat.authInfo = ctx.http?.authInfo;
        compat.requestInfo = env.httpReq;
        return ctx;
    }

    private async _elicitInputViaCtx(
        base: BaseContext,
        params: ElicitRequestFormParams | ElicitRequestURLParams,
        options?: RequestOptions
    ): Promise<ElicitResult> {
        const mode = (params.mode ?? 'form') as 'form' | 'url';
        const formParams = mode === 'form' && params.mode !== 'form' ? { ...params, mode: 'form' as const } : params;
        const result = (await base.mcpReq.send({ method: 'elicitation/create', params: formParams }, options)) as ElicitResult;
        return this._validateElicitResult(result, mode === 'form' ? (formParams as ElicitRequestFormParams) : undefined);
    }

    private async _createMessageViaCtx(
        base: BaseContext,
        params: CreateMessageRequest['params'],
        options?: RequestOptions
    ): Promise<CreateMessageResult | CreateMessageResultWithTools> {
        return base.mcpReq.send({ method: 'sampling/createMessage', params }, options) as Promise<
            CreateMessageResult | CreateMessageResultWithTools
        >;
    }

    // ───────────────────────────────────────────────────────────────────────
    // Capabilities & initialize
    // ───────────────────────────────────────────────────────────────────────

    private async _oninitialize(request: InitializeRequest): Promise<InitializeResult> {
        const requestedVersion = request.params.protocolVersion;
        this._clientCapabilities = request.params.capabilities;
        this._clientVersion = request.params.clientInfo;

        const protocolVersion = this._supportedProtocolVersions.includes(requestedVersion)
            ? requestedVersion
            : (this._supportedProtocolVersions[0] ?? LATEST_PROTOCOL_VERSION);

        this._driver?.pipe.setProtocolVersion?.(protocolVersion);

        return {
            protocolVersion,
            capabilities: this.getCapabilities(),
            serverInfo: this._serverInfo,
            ...(this._instructions && { instructions: this._instructions })
        };
    }

    /**
     * After initialization, populated with the client's reported capabilities.
     */
    getClientCapabilities(): ClientCapabilities | undefined {
        return this._clientCapabilities;
    }

    /**
     * After initialization, populated with the client's name and version.
     */
    getClientVersion(): Implementation | undefined {
        return this._clientVersion;
    }

    /**
     * Returns the current server capabilities.
     */
    getCapabilities(): ServerCapabilities {
        return this._capabilities;
    }

    /**
     * Registers new capabilities. Can only be called before connecting to a transport.
     */
    registerCapabilities(capabilities: ServerCapabilities): void {
        if (this._driver) {
            throw new SdkError(SdkErrorCode.AlreadyConnected, 'Cannot register capabilities after connecting to transport');
        }
        const hadLogging = !!this._capabilities.logging;
        this._capabilities = mergeCapabilities(this._capabilities, capabilities);
        if (!hadLogging && this._capabilities.logging) {
            this._registerLoggingHandler();
        }
    }

    /**
     * Override request handler registration to enforce server-side validation for `tools/call`.
     *
     * Also accepts the v1 form `setRequestHandler(zodRequestSchema, handler)` where the schema
     * has a literal `method` shape (e.g. `z.object({method: z.literal('resources/subscribe')})`).
     */
    public override setRequestHandler<M extends RequestMethod>(
        method: M,
        handler: (request: RequestTypeMap[M], ctx: ServerContext) => ResultTypeMap[M] | Promise<ResultTypeMap[M]>
    ): void;
    /** @deprecated Pass a method string instead of a Zod request schema. */
    public override setRequestHandler(
        schema: { shape: { method: unknown } },
        handler: (request: JSONRPCRequest, ctx: ServerContext) => Result | Promise<Result>
    ): void;
    public override setRequestHandler(
        methodOrSchema: RequestMethod | { shape: { method: unknown } },
        handler: (request: never, ctx: ServerContext) => Result | Promise<Result>
    ): void {
        const method = (
            typeof methodOrSchema === 'string' ? methodOrSchema : extractMethodFromSchema(methodOrSchema)
        ) as RequestMethod;
        this._assertRequestHandlerCapability(method);
        const h = handler as (request: JSONRPCRequest, ctx: ServerContext) => Result | Promise<Result>;
        if (method === 'tools/call') {
            const wrapped = async (request: JSONRPCRequest, ctx: ServerContext): Promise<ServerResult> => {
                const validated = parseSchema(CallToolRequestSchema, request);
                if (!validated.success) {
                    const msg = validated.error instanceof Error ? validated.error.message : String(validated.error);
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid tools/call request: ${msg}`);
                }
                const { params } = validated.data;
                const result = await Promise.resolve(h(request, ctx));
                if (params.task) {
                    const taskValidation = parseSchema(CreateTaskResultSchema, result);
                    if (!taskValidation.success) {
                        const msg = taskValidation.error instanceof Error ? taskValidation.error.message : String(taskValidation.error);
                        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid task creation result: ${msg}`);
                    }
                    return taskValidation.data;
                }
                const resultValidation = parseSchema(CallToolResultSchema, result);
                if (!resultValidation.success) {
                    const msg = resultValidation.error instanceof Error ? resultValidation.error.message : String(resultValidation.error);
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid tools/call result: ${msg}`);
                }
                return resultValidation.data;
            };
            return super.setRequestHandler(method, wrapped as never);
        }
        return super.setRequestHandler(method, h as never);
    }

    // ───────────────────────────────────────────────────────────────────────
    // Server→client requests (only work when connected via StreamDriver)
    // ───────────────────────────────────────────────────────────────────────

    private _requireDriver(): StreamDriver {
        if (!this._driver) {
            throw new SdkError(
                SdkErrorCode.NotConnected,
                'Server is not connected to a stream transport. Use ctx.mcpReq.* inside handlers, or the MRTR-native return form, or call connect().'
            );
        }
        return this._driver;
    }

    private _driverRequest<T>(req: Request, schema: { parse(v: unknown): T }, options?: RequestOptions): Promise<T> {
        if (this._options?.enforceStrictCapabilities === true) {
            this._assertCapabilityForMethod(req.method as RequestMethod);
        }
        return this._requireDriver().request(req, schema as never, options) as Promise<T>;
    }

    /**
     * Sends a request to the connected peer and awaits the result. Result schema is
     * resolved from the method name.
     */
    async request<M extends RequestMethod>(
        req: { method: M; params?: Record<string, unknown> },
        options?: RequestOptions
    ): Promise<ResultTypeMap[M]> {
        return this._driverRequest(req as Request, getResultSchema(req.method), options) as Promise<ResultTypeMap[M]>;
    }

    async ping(): Promise<Result> {
        return this._driverRequest({ method: 'ping' }, EmptyResultSchema);
    }

    /**
     * Request LLM sampling from the client. Only available when connected via {@linkcode connect}.
     * Inside a request handler, prefer `ctx.mcpReq.requestSampling`.
     */
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
            return this._driverRequest({ method: 'sampling/createMessage', params }, CreateMessageResultWithToolsSchema, options);
        }
        return this._driverRequest({ method: 'sampling/createMessage', params }, CreateMessageResultSchema, options);
    }

    /**
     * Creates an elicitation request. Only available when connected via {@linkcode connect}.
     * Inside a request handler, prefer `ctx.mcpReq.elicitInput`.
     */
    async elicitInput(params: ElicitRequestFormParams | ElicitRequestURLParams, options?: RequestOptions): Promise<ElicitResult> {
        const mode = (params.mode ?? 'form') as 'form' | 'url';
        switch (mode) {
            case 'url': {
                if (this._clientCapabilities && !this._clientCapabilities.elicitation?.url) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, 'Client does not support url elicitation.');
                }
                const urlParams = params as ElicitRequestURLParams;
                return this._driverRequest({ method: 'elicitation/create', params: urlParams }, ElicitResultSchema, options);
            }
            case 'form': {
                if (this._clientCapabilities && !this._clientCapabilities.elicitation?.form) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, 'Client does not support form elicitation.');
                }
                const formParams: ElicitRequestFormParams =
                    params.mode === 'form' ? (params as ElicitRequestFormParams) : { ...(params as ElicitRequestFormParams), mode: 'form' };
                const result = await this._driverRequest({ method: 'elicitation/create', params: formParams }, ElicitResultSchema, options);
                return this._validateElicitResult(result, formParams);
            }
        }
    }

    private _validateElicitResult(result: ElicitResult, formParams?: ElicitRequestFormParams): ElicitResult {
        if (result.action === 'accept' && result.content && formParams?.requestedSchema) {
            try {
                const validator = this._jsonSchemaValidator.getValidator(formParams.requestedSchema as JsonSchemaType);
                const validation = validator(result.content);
                if (!validation.valid) {
                    throw new ProtocolError(
                        ProtocolErrorCode.InvalidParams,
                        `Elicitation response content does not match requested schema: ${validation.errorMessage}`
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

    createElicitationCompletionNotifier(elicitationId: string, options?: NotificationOptions): () => Promise<void> {
        if (this._clientCapabilities && !this._clientCapabilities.elicitation?.url) {
            throw new SdkError(
                SdkErrorCode.CapabilityNotSupported,
                'Client does not support URL elicitation (required for notifications/elicitation/complete)'
            );
        }
        return () => this.notification({ method: 'notifications/elicitation/complete', params: { elicitationId } }, options);
    }

    async listRoots(params?: ListRootsRequest['params'], options?: RequestOptions) {
        return this._driverRequest({ method: 'roots/list', params }, ListRootsResultSchema, options);
    }

    // ───────────────────────────────────────────────────────────────────────
    // Outbound notifications
    // ───────────────────────────────────────────────────────────────────────

    /**
     * Sends a notification over the connected transport. No-op when not connected.
     */
    async notification(notification: Notification, options?: NotificationOptions): Promise<void> {
        this._assertNotificationCapability(notification.method as NotificationMethod);
        await this._driver?.notification(notification, options);
    }

    // ───────────────────────────────────────────────────────────────────────
    // Capability assertions (v1 compat). No-ops once capabilities move per-request.
    // ───────────────────────────────────────────────────────────────────────

    private _assertCapabilityForMethod(method: RequestMethod): void {
        switch (method) {
            case 'sampling/createMessage':
                if (!this._clientCapabilities?.sampling) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support sampling (required for ${method})`);
                }
                break;
            case 'elicitation/create':
                if (!this._clientCapabilities?.elicitation) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support elicitation (required for ${method})`);
                }
                break;
            case 'roots/list':
                if (!this._clientCapabilities?.roots) {
                    throw new SdkError(
                        SdkErrorCode.CapabilityNotSupported,
                        `Client does not support listing roots (required for ${method})`
                    );
                }
                break;
        }
    }

    private _assertNotificationCapability(method: NotificationMethod): void {
        switch (method) {
            case 'notifications/message':
                if (!this._capabilities.logging) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support logging (required for ${method})`);
                }
                break;
            case 'notifications/resources/updated':
            case 'notifications/resources/list_changed':
                if (!this._capabilities.resources) {
                    throw new SdkError(
                        SdkErrorCode.CapabilityNotSupported,
                        `Server does not support notifying about resources (required for ${method})`
                    );
                }
                break;
            case 'notifications/tools/list_changed':
                if (!this._capabilities.tools) {
                    throw new SdkError(
                        SdkErrorCode.CapabilityNotSupported,
                        `Server does not support notifying of tool list changes (required for ${method})`
                    );
                }
                break;
            case 'notifications/prompts/list_changed':
                if (!this._capabilities.prompts) {
                    throw new SdkError(
                        SdkErrorCode.CapabilityNotSupported,
                        `Server does not support notifying of prompt list changes (required for ${method})`
                    );
                }
                break;
            case 'notifications/elicitation/complete':
                if (!this._clientCapabilities?.elicitation?.url) {
                    throw new SdkError(
                        SdkErrorCode.CapabilityNotSupported,
                        `Client does not support URL elicitation (required for ${method})`
                    );
                }
                break;
        }
    }

    private _assertRequestHandlerCapability(method: string): void {
        switch (method) {
            case 'completion/complete':
                if (!this._capabilities.completions) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support completions (required for ${method})`);
                }
                break;
            case 'logging/setLevel':
                if (!this._capabilities.logging) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support logging (required for ${method})`);
                }
                break;
            case 'prompts/get':
            case 'prompts/list':
                if (!this._capabilities.prompts) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support prompts (required for ${method})`);
                }
                break;
            case 'resources/list':
            case 'resources/templates/list':
            case 'resources/read':
            case 'resources/subscribe':
            case 'resources/unsubscribe':
                if (!this._capabilities.resources) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support resources (required for ${method})`);
                }
                break;
            case 'tools/call':
            case 'tools/list':
                if (!this._capabilities.tools) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support tools (required for ${method})`);
                }
                break;
        }
    }

    private _assertTaskCapability(method: string): void {
        assertClientRequestTaskCapability(this._clientCapabilities?.tasks?.requests, method, 'Client');
    }

    private _assertTaskHandlerCapability(method: string): void {
        assertToolsCallTaskCapability(this._capabilities?.tasks?.requests, method, 'Server');
    }

    async sendLoggingMessage(params: LoggingMessageNotification['params'], sessionId?: string): Promise<void> {
        if (this._capabilities.logging && !this._isMessageIgnored(params.level, sessionId)) {
            return this.notification({ method: 'notifications/message', params });
        }
    }

    async sendResourceUpdated(params: ResourceUpdatedNotification['params']): Promise<void> {
        return this.notification({ method: 'notifications/resources/updated', params });
    }

    async sendResourceListChanged(): Promise<void> {
        if (this.isConnected()) return this.notification({ method: 'notifications/resources/list_changed' });
    }

    async sendToolListChanged(): Promise<void> {
        if (this.isConnected()) return this.notification({ method: 'notifications/tools/list_changed' });
    }

    async sendPromptListChanged(): Promise<void> {
        if (this.isConnected()) return this.notification({ method: 'notifications/prompts/list_changed' });
    }

    private _registerLoggingHandler(): void {
        this.setRequestHandler('logging/setLevel', async (request, ctx) => {
            const transportSessionId = ctx.sessionId || ctx.http?.req?.headers.get('mcp-session-id') || undefined;
            const { level } = request.params;
            const parsed = parseSchema(LoggingLevelSchema, level);
            if (parsed.success) {
                this._loggingLevels.set(transportSessionId, parsed.data);
            }
            return {};
        });
    }

    private _isMessageIgnored(level: LoggingLevel, sessionId?: string): boolean {
        const currentLevel = this._loggingLevels.get(sessionId);
        return currentLevel ? this.LOG_LEVEL_SEVERITY.get(level)! < this.LOG_LEVEL_SEVERITY.get(currentLevel)! : false;
    }

    // ───────────────────────────────────────────────────────────────────────
    // Tool/Resource/Prompt registries
    // ───────────────────────────────────────────────────────────────────────

    private setToolRequestHandlers(): void {
        if (this._toolHandlersInitialized) return;
        this.assertCanSetRequestHandler('tools/list');
        this.assertCanSetRequestHandler('tools/call');
        this.registerCapabilities({ tools: { listChanged: this.getCapabilities().tools?.listChanged ?? true } });

        this.setRequestHandler(
            'tools/list',
            (): ListToolsResult => ({
                tools: Object.entries(this._registeredTools)
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

        this.setRequestHandler('tools/call', async (request, ctx): Promise<CallToolResult | CreateTaskResult> => {
            const tool = this._registeredTools[request.params.name];
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
                const result = await this.executeToolHandler(tool, args, ctx);
                if (isTaskRequest) return result;
                await this.validateToolOutput(tool, result, request.params.name);
                return result;
            } catch (error) {
                if (error instanceof ProtocolError && error.code === ProtocolErrorCode.UrlElicitationRequired) {
                    throw error;
                }
                return this.createToolError(error instanceof Error ? error.message : String(error));
            }
        });

        this._toolHandlersInitialized = true;
    }

    private createToolError(errorMessage: string): CallToolResult {
        return { content: [{ type: 'text', text: errorMessage }], isError: true };
    }

    private async validateToolInput<
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

    private async validateToolOutput(tool: RegisteredTool, result: CallToolResult | CreateTaskResult, toolName: string): Promise<void> {
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

    private async executeToolHandler(tool: RegisteredTool, args: unknown, ctx: ServerContext): Promise<CallToolResult | CreateTaskResult> {
        return tool.executor(args, ctx);
    }

    private async handleAutomaticTaskPolling<RequestT extends CallToolRequest>(
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

    private setCompletionRequestHandler(): void {
        if (this._completionHandlerInitialized) return;
        this.assertCanSetRequestHandler('completion/complete');
        this.registerCapabilities({ completions: {} });
        this.setRequestHandler('completion/complete', async (request): Promise<CompleteResult> => {
            switch (request.params.ref.type) {
                case 'ref/prompt': {
                    assertCompleteRequestPrompt(request);
                    return this.handlePromptCompletion(request, request.params.ref);
                }
                case 'ref/resource': {
                    assertCompleteRequestResourceTemplate(request);
                    return this.handleResourceCompletion(request, request.params.ref);
                }
                default:
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid completion reference: ${request.params.ref}`);
            }
        });
        this._completionHandlerInitialized = true;
    }

    private async handlePromptCompletion(request: CompleteRequestPrompt, ref: PromptReference): Promise<CompleteResult> {
        const prompt = this._registeredPrompts[ref.name];
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
        const template = Object.values(this._registeredResourceTemplates).find(t => t.resourceTemplate.uriTemplate.toString() === ref.uri);
        if (!template) {
            if (this._registeredResources[ref.uri]) return EMPTY_COMPLETION_RESULT;
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource template ${request.params.ref.uri} not found`);
        }
        const completer = template.resourceTemplate.completeCallback(request.params.argument.name);
        if (!completer) return EMPTY_COMPLETION_RESULT;
        const suggestions = await completer(request.params.argument.value, request.params.context);
        return createCompletionResult(suggestions);
    }

    private setResourceRequestHandlers(): void {
        if (this._resourceHandlersInitialized) return;
        this.assertCanSetRequestHandler('resources/list');
        this.assertCanSetRequestHandler('resources/templates/list');
        this.assertCanSetRequestHandler('resources/read');
        this.registerCapabilities({ resources: { listChanged: this.getCapabilities().resources?.listChanged ?? true } });

        this.setRequestHandler('resources/list', async (_request, ctx) => {
            const resources = Object.entries(this._registeredResources)
                .filter(([_, r]) => r.enabled)
                .map(([uri, r]) => ({ uri, name: r.name, ...r.metadata }));
            const templateResources: Resource[] = [];
            for (const template of Object.values(this._registeredResourceTemplates)) {
                if (!template.resourceTemplate.listCallback) continue;
                const result = await template.resourceTemplate.listCallback(ctx);
                for (const resource of result.resources) {
                    templateResources.push({ ...template.metadata, ...resource });
                }
            }
            return { resources: [...resources, ...templateResources] };
        });

        this.setRequestHandler('resources/templates/list', async () => {
            const resourceTemplates = Object.entries(this._registeredResourceTemplates).map(([name, t]) => ({
                name,
                uriTemplate: t.resourceTemplate.uriTemplate.toString(),
                ...t.metadata
            }));
            return { resourceTemplates };
        });

        this.setRequestHandler('resources/read', async (request, ctx) => {
            const uri = new URL(request.params.uri);
            const resource = this._registeredResources[uri.toString()];
            if (resource) {
                if (!resource.enabled) {
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource ${uri} disabled`);
                }
                return resource.readCallback(uri, ctx);
            }
            for (const template of Object.values(this._registeredResourceTemplates)) {
                const variables = template.resourceTemplate.uriTemplate.match(uri.toString());
                if (variables) return template.readCallback(uri, variables, ctx);
            }
            throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, `Resource ${uri} not found`);
        });

        this._resourceHandlersInitialized = true;
    }

    private setPromptRequestHandlers(): void {
        if (this._promptHandlersInitialized) return;
        this.assertCanSetRequestHandler('prompts/list');
        this.assertCanSetRequestHandler('prompts/get');
        this.registerCapabilities({ prompts: { listChanged: this.getCapabilities().prompts?.listChanged ?? true } });

        this.setRequestHandler(
            'prompts/list',
            (): ListPromptsResult => ({
                prompts: Object.entries(this._registeredPrompts)
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

        this.setRequestHandler('prompts/get', async (request, ctx): Promise<GetPromptResult> => {
            const prompt = this._registeredPrompts[request.params.name];
            if (!prompt) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Prompt ${request.params.name} not found`);
            if (!prompt.enabled) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Prompt ${request.params.name} disabled`);
            return prompt.handler(request.params.arguments, ctx);
        });

        this._promptHandlersInitialized = true;
    }

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
            if (this._registeredResources[uriOrTemplate]) throw new Error(`Resource ${uriOrTemplate} is already registered`);
            const r = this._createRegisteredResource(
                name,
                (config as BaseMetadata).title,
                uriOrTemplate,
                config,
                readCallback as ReadResourceCallback
            );
            this.setResourceRequestHandlers();
            this.sendResourceListChanged();
            return r;
        } else {
            if (this._registeredResourceTemplates[name]) throw new Error(`Resource template ${name} is already registered`);
            const r = this._createRegisteredResourceTemplate(
                name,
                (config as BaseMetadata).title,
                uriOrTemplate,
                config,
                readCallback as ReadResourceTemplateCallback
            );
            this.setResourceRequestHandlers();
            this.sendResourceListChanged();
            return r;
        }
    }

    private _createRegisteredResource(
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
                    delete this._registeredResources[uri];
                    if (updates.uri) this._registeredResources[updates.uri] = r;
                }
                if (updates.name !== undefined) r.name = updates.name;
                if (updates.title !== undefined) r.title = updates.title;
                if (updates.metadata !== undefined) r.metadata = updates.metadata;
                if (updates.callback !== undefined) r.readCallback = updates.callback;
                if (updates.enabled !== undefined) r.enabled = updates.enabled;
                this.sendResourceListChanged();
            }
        };
        this._registeredResources[uri] = r;
        return r;
    }

    private _createRegisteredResourceTemplate(
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
                    delete this._registeredResourceTemplates[name];
                    if (updates.name) this._registeredResourceTemplates[updates.name] = r;
                }
                if (updates.title !== undefined) r.title = updates.title;
                if (updates.template !== undefined) r.resourceTemplate = updates.template;
                if (updates.metadata !== undefined) r.metadata = updates.metadata;
                if (updates.callback !== undefined) r.readCallback = updates.callback;
                if (updates.enabled !== undefined) r.enabled = updates.enabled;
                this.sendResourceListChanged();
            }
        };
        this._registeredResourceTemplates[name] = r;
        const variableNames = template.uriTemplate.variableNames;
        const hasCompleter = Array.isArray(variableNames) && variableNames.some(v => !!template.completeCallback(v));
        if (hasCompleter) this.setCompletionRequestHandler();
        return r;
    }

    private _createRegisteredPrompt(
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
                    delete this._registeredPrompts[name];
                    if (updates.name) this._registeredPrompts[updates.name] = r;
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
                this.sendPromptListChanged();
            }
        };
        this._registeredPrompts[name] = r;
        if (argsSchema) {
            const shape = getSchemaShape(argsSchema);
            if (shape) {
                const hasCompletable = Object.values(shape).some(f => isCompletable(unwrapOptionalSchema(f)));
                if (hasCompletable) this.setCompletionRequestHandler();
            }
        }
        return r;
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
                    delete this._registeredTools[name];
                    if (updates.name) this._registeredTools[updates.name] = r;
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
                this.sendToolListChanged();
            }
        };
        this._registeredTools[name] = r;
        this.setToolRequestHandlers();
        this.sendToolListChanged();
        return r;
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
        if (this._registeredTools[name]) throw new Error(`Tool ${name} is already registered`);
        const { title, description, inputSchema, outputSchema, annotations, _meta } = config;
        return this._createRegisteredTool(
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
        if (this._registeredPrompts[name]) throw new Error(`Prompt ${name} is already registered`);
        const { title, description, argsSchema, _meta } = config;
        const r = this._createRegisteredPrompt(
            name,
            title,
            description,
            coerceSchema(argsSchema),
            cb as PromptCallback<StandardSchemaWithJSON | undefined>,
            _meta
        );
        this.setPromptRequestHandlers();
        this.sendPromptListChanged();
        return r;
    }

    // ───────────────────────────────────────────────────────────────────────
    // Deprecated v1 overloads (positional, raw-shape) — call register* internally
    // ───────────────────────────────────────────────────────────────────────

    /** @deprecated Use {@linkcode McpServer.registerTool | registerTool()} instead. */
    tool(name: string, cb: ToolCallback): RegisteredTool;
    /** @deprecated Use {@linkcode McpServer.registerTool | registerTool()} instead. */
    tool(name: string, description: string, cb: ToolCallback): RegisteredTool;
    /** @deprecated Use {@linkcode McpServer.registerTool | registerTool()} instead. */
    tool<Args extends ZodRawShapeCompat>(name: string, paramsSchemaOrAnnotations: Args | ToolAnnotations, cb: LegacyToolCallback<Args>): RegisteredTool;
    /** @deprecated Use {@linkcode McpServer.registerTool | registerTool()} instead. */
    tool<Args extends ZodRawShapeCompat>(
        name: string,
        description: string,
        paramsSchemaOrAnnotations: Args | ToolAnnotations,
        cb: LegacyToolCallback<Args>
    ): RegisteredTool;
    /** @deprecated Use {@linkcode McpServer.registerTool | registerTool()} instead. */
    tool<Args extends ZodRawShapeCompat>(name: string, paramsSchema: Args, annotations: ToolAnnotations, cb: LegacyToolCallback<Args>): RegisteredTool;
    /** @deprecated Use {@linkcode McpServer.registerTool | registerTool()} instead. */
    tool<Args extends ZodRawShapeCompat>(
        name: string,
        description: string,
        paramsSchema: Args,
        annotations: ToolAnnotations,
        cb: LegacyToolCallback<Args>
    ): RegisteredTool;
    tool(name: string, ...rest: unknown[]): RegisteredTool {
        if (this._registeredTools[name]) throw new Error(`Tool ${name} is already registered`);
        let description: string | undefined;
        let inputSchema: StandardSchemaWithJSON | undefined;
        let annotations: ToolAnnotations | undefined;
        if (typeof rest[0] === 'string') description = rest.shift() as string;
        if (rest.length > 1) {
            const first = rest[0];
            if (isZodRawShapeCompat(first) || isStandardSchema(first)) {
                inputSchema = coerceSchema(rest.shift());
                if (rest.length > 1 && typeof rest[0] === 'object' && rest[0] !== null && !isZodRawShapeCompat(rest[0])) {
                    annotations = rest.shift() as ToolAnnotations;
                }
            } else if (typeof first === 'object' && first !== null) {
                if (Object.values(first).some(v => typeof v === 'object' && v !== null)) {
                    throw new Error(`Tool ${name} expected a Zod schema or ToolAnnotations, but received an unrecognized object`);
                }
                annotations = rest.shift() as ToolAnnotations;
            }
        }
        const cb = rest[0] as ToolCallback<StandardSchemaWithJSON | undefined>;
        return this._createRegisteredTool(name, undefined, description, inputSchema, undefined, annotations, { taskSupport: 'forbidden' }, undefined, cb);
    }

    /** @deprecated Use {@linkcode McpServer.registerPrompt | registerPrompt()} instead. */
    prompt(name: string, cb: PromptCallback): RegisteredPrompt;
    /** @deprecated Use {@linkcode McpServer.registerPrompt | registerPrompt()} instead. */
    prompt(name: string, description: string, cb: PromptCallback): RegisteredPrompt;
    /** @deprecated Use {@linkcode McpServer.registerPrompt | registerPrompt()} instead. */
    prompt<Args extends ZodRawShapeCompat>(name: string, argsSchema: Args, cb: LegacyPromptCallback<Args>): RegisteredPrompt;
    /** @deprecated Use {@linkcode McpServer.registerPrompt | registerPrompt()} instead. */
    prompt<Args extends ZodRawShapeCompat>(name: string, description: string, argsSchema: Args, cb: LegacyPromptCallback<Args>): RegisteredPrompt;
    prompt(name: string, ...rest: unknown[]): RegisteredPrompt {
        if (this._registeredPrompts[name]) throw new Error(`Prompt ${name} is already registered`);
        let description: string | undefined;
        if (typeof rest[0] === 'string') description = rest.shift() as string;
        let argsSchema: StandardSchemaWithJSON | undefined;
        if (rest.length > 1) argsSchema = coerceSchema(rest.shift());
        const cb = rest[0] as PromptCallback<StandardSchemaWithJSON | undefined>;
        const r = this._createRegisteredPrompt(name, undefined, description, argsSchema, cb, undefined);
        this.setPromptRequestHandlers();
        this.sendPromptListChanged();
        return r;
    }

    /** @deprecated Use {@linkcode McpServer.registerResource | registerResource()} instead. */
    resource(name: string, uri: string, readCallback: ReadResourceCallback): RegisteredResource;
    /** @deprecated Use {@linkcode McpServer.registerResource | registerResource()} instead. */
    resource(name: string, uri: string, metadata: ResourceMetadata, readCallback: ReadResourceCallback): RegisteredResource;
    /** @deprecated Use {@linkcode McpServer.registerResource | registerResource()} instead. */
    resource(name: string, template: ResourceTemplate, readCallback: ReadResourceTemplateCallback): RegisteredResourceTemplate;
    /** @deprecated Use {@linkcode McpServer.registerResource | registerResource()} instead. */
    resource(name: string, template: ResourceTemplate, metadata: ResourceMetadata, readCallback: ReadResourceTemplateCallback): RegisteredResourceTemplate;
    resource(name: string, uriOrTemplate: string | ResourceTemplate, ...rest: unknown[]): RegisteredResource | RegisteredResourceTemplate {
        let metadata: ResourceMetadata | undefined;
        if (typeof rest[0] === 'object') metadata = rest.shift() as ResourceMetadata;
        const readCallback = rest[0] as ReadResourceCallback | ReadResourceTemplateCallback;
        if (typeof uriOrTemplate === 'string') {
            if (this._registeredResources[uriOrTemplate]) throw new Error(`Resource ${uriOrTemplate} is already registered`);
            const r = this._createRegisteredResource(name, undefined, uriOrTemplate, metadata, readCallback as ReadResourceCallback);
            this.setResourceRequestHandlers();
            this.sendResourceListChanged();
            return r;
        }
        if (this._registeredResourceTemplates[name]) throw new Error(`Resource template ${name} is already registered`);
        const r = this._createRegisteredResourceTemplate(name, undefined, uriOrTemplate, metadata, readCallback as ReadResourceTemplateCallback);
        this.setResourceRequestHandlers();
        this.sendResourceListChanged();
        return r;
    }
}

// ───────────────────────────────────────────────────────────────────────────
// ResourceTemplate
// ───────────────────────────────────────────────────────────────────────────

/**
 * A callback to complete one variable within a resource template's URI template.
 */
export type CompleteResourceTemplateCallback = (
    value: string,
    context?: { arguments?: Record<string, string> }
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
            list: ListResourcesCallback | undefined;
            complete?: { [variable: string]: CompleteResourceTemplateCallback };
        }
    ) {
        this._uriTemplate = typeof uriTemplate === 'string' ? new UriTemplate(uriTemplate) : uriTemplate;
    }

    get uriTemplate(): UriTemplate {
        return this._uriTemplate;
    }

    get listCallback(): ListResourcesCallback | undefined {
        return this._callbacks.list;
    }

    completeCallback(variable: string): CompleteResourceTemplateCallback | undefined {
        return this._callbacks.complete?.[variable];
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
export type ListResourcesCallback = (ctx: ServerContext) => ListResourcesResult | Promise<ListResourcesResult>;
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

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

const EMPTY_OBJECT_JSON_SCHEMA = { type: 'object' as const, properties: {} };
const EMPTY_COMPLETION_RESULT: CompleteResult = { completion: { values: [], hasMore: false } };

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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

/**
 * v1 compat: a "raw shape" is a plain object whose values are Zod schemas
 * (e.g. `{ name: z.string() }`), or an empty object. v1's `tool()`/`prompt()`
 * and `registerTool({inputSchema:{}})` accepted these directly.
 */
type ZodRawShapeCompat = Record<string, z.core.$ZodType>;

/** v1-style callback signature for the deprecated {@linkcode McpServer.tool | tool()} overloads. */
type LegacyToolCallback<Args extends ZodRawShapeCompat> = (
    args: z.infer<z.ZodObject<Args>>,
    ctx: ServerContext
) => CallToolResult | Promise<CallToolResult>;

/** v1-style callback signature for the deprecated {@linkcode McpServer.prompt | prompt()} overloads. */
type LegacyPromptCallback<Args extends ZodRawShapeCompat> = (
    args: z.infer<z.ZodObject<Args>>,
    ctx: ServerContext
) => GetPromptResult | Promise<GetPromptResult>;

/**
 * v1 compat: extract the literal method string from a `z.object({method: z.literal('x'), ...})` schema.
 */
function extractMethodFromSchema(schema: { shape: { method: unknown } }): string {
    const lit = schema.shape.method as { value?: unknown; _zod?: { def?: { values?: unknown[] } } };
    const v = lit?.value ?? lit?._zod?.def?.values?.[0];
    if (typeof v !== 'string') {
        throw new Error('setRequestHandler(schema, handler): schema.shape.method must be a z.literal(string)');
    }
    return v;
}

function isZodTypeLike(v: unknown): boolean {
    return v != null && typeof v === 'object' && '_zod' in (v as object);
}

function isZodRawShapeCompat(v: unknown): v is ZodRawShapeCompat {
    if (v == null || typeof v !== 'object') return false;
    if (isStandardSchema(v)) return false;
    const values = Object.values(v as object);
    if (values.length === 0) return true;
    return values.some(isZodTypeLike);
}

/**
 * Coerce a v1-style raw Zod shape (or empty object) to a {@linkcode StandardSchemaWithJSON}.
 * Standard Schemas pass through unchanged.
 */
function coerceSchema(schema: unknown): StandardSchemaWithJSON | undefined {
    if (schema == null) return undefined;
    if (isStandardSchemaWithJSON(schema)) return schema;
    if (isZodRawShapeCompat(schema)) return z.object(schema) as unknown as StandardSchemaWithJSON;
    if (isStandardSchema(schema)) {
        throw new Error('Schema lacks JSON-Schema emission (zod >=4.2 or equivalent required).');
    }
    throw new Error('inputSchema/argsSchema must be a Standard Schema or a Zod raw shape (e.g. {name: z.string()})');
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
