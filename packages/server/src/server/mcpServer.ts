import type {
    AuthInfo,
    BaseContext,
    CallToolRequest,
    CallToolResult,
    ClientCapabilities,
    CreateMessageRequest,
    CreateMessageRequestParamsBase,
    CreateMessageRequestParamsWithTools,
    CreateMessageResult,
    CreateMessageResultWithTools,
    CreateTaskResult,
    DispatchEnv,
    DispatchOutput,
    ElicitRequestFormParams,
    ElicitRequestURLParams,
    ElicitResult,
    Implementation,
    InboundContext,
    InitializeRequest,
    InitializeResult,
    JSONRPCErrorResponse,
    JSONRPCMessage,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResponse,
    JsonSchemaType,
    jsonSchemaValidator,
    ListRootsRequest,
    LoggingLevel,
    LoggingMessageNotification,
    MessageExtraInfo,
    Notification,
    NotificationMethod,
    NotificationOptions,
    ProtocolOptions,
    Request,
    RequestId,
    RequestMethod,
    RequestOptions,
    RequestTypeMap,
    ResourceUpdatedNotification,
    Result,
    ResultTypeMap,
    ServerCapabilities,
    ServerContext,
    ServerResult,
    StandardSchemaV1,
    StandardSchemaWithJSON,
    StreamDriverOptions,
    TaskManagerHost,
    TaskManagerOptions,
    ToolAnnotations,
    ToolExecution,
    ToolResultContent,
    ToolUseContent,
    Transport
} from '@modelcontextprotocol/core';
import {
    assertClientRequestTaskCapability,
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
    LATEST_PROTOCOL_VERSION,
    ListRootsResultSchema,
    LoggingLevelSchema,
    mergeCapabilities,
    NullTaskManager,
    parseSchema,
    ProtocolError,
    ProtocolErrorCode,
    RELATED_TASK_META_KEY,
    SdkError,
    SdkErrorCode,
    StreamDriver,
    SUPPORTED_PROTOCOL_VERSIONS,
    TaskManager
} from '@modelcontextprotocol/core';
import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/server/_shims';

import { ExperimentalMcpServerTasks } from '../experimental/tasks/mcpServer.js';
import type { ResourceTemplate } from './resourceTemplate.js';
import { assertCapabilityForMethod, assertNotificationCapability, assertRequestHandlerCapability } from './serverCapabilities.js';
import type { LegacyPromptCallback, LegacyToolCallback, ZodRawShapeCompat } from './serverLegacy.js';
import { extractMethodFromSchema, parseLegacyPromptArgs, parseLegacyToolArgs } from './serverLegacy.js';
import type {
    AnyToolHandler,
    PromptCallback,
    ReadResourceCallback,
    ReadResourceTemplateCallback,
    RegisteredPrompt,
    RegisteredResource,
    RegisteredResourceTemplate,
    RegisteredTool,
    RegistriesHost,
    ResourceMetadata,
    ToolCallback
} from './serverRegistries.js';
import { ServerRegistries } from './serverRegistries.js';

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
export class McpServer extends Dispatcher<ServerContext> implements RegistriesHost {
    private _driver?: StreamDriver;
    private readonly _registries = new ServerRegistries(this);
    private readonly _dispatchYielders = new Map<RequestId, (msg: JSONRPCMessage) => void>();
    private _dispatchOutboundId = 0;

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
    // Direct dispatch
    // ───────────────────────────────────────────────────────────────────────

    /**
     * Task-aware dispatch. Threads {@linkcode TaskManager.processInboundRequest} so
     * `tasks/*` methods, task-augmented `tools/call`, and `routeResponse` queueing all
     * work for callers that bypass {@linkcode StreamDriver} (e.g. {@linkcode shttpHandler}).
     */
    override async *dispatch(request: JSONRPCRequest, env: DispatchEnv = {}): AsyncGenerator<DispatchOutput, void, void> {
        const sendOnStream = env.send;
        const inboundCtx: InboundContext = {
            sessionId: env.sessionId,
            sendNotification: async () => {},
            sendRequest: (r, schema, opts) =>
                new Promise((resolve, reject) => {
                    const messageId = this._dispatchOutboundId++;
                    const wire: JSONRPCRequest = { jsonrpc: '2.0', id: messageId, method: r.method, params: r.params };
                    const settle = (resp: { result: Result } | Error) => {
                        if (resp instanceof Error) return reject(resp);
                        const parsed = parseSchema(schema, resp.result);
                        if (parsed.success) {
                            resolve(parsed.data);
                        } else {
                            reject(parsed.error);
                        }
                    };
                    const { queued } = this._taskManager.processOutboundRequest(wire, opts, messageId, settle, reject);
                    if (queued) return;
                    if (!sendOnStream) {
                        reject(
                            new SdkError(
                                SdkErrorCode.NotConnected,
                                'ctx.mcpReq.send is unavailable: no peer channel. Use the MRTR-native return form for elicitation/sampling, or run via connect()/StreamDriver.'
                            )
                        );
                        return;
                    }
                    sendOnStream({ method: wire.method, params: wire.params }, opts).then(result => settle({ result }), reject);
                })
        };
        const taskResult = this._taskManager.processInboundRequest(request, inboundCtx);

        if (taskResult.validateInbound) {
            try {
                taskResult.validateInbound();
            } catch (error) {
                const e = error as { code?: number; message?: string; data?: unknown };
                yield {
                    kind: 'response',
                    message: {
                        jsonrpc: '2.0',
                        id: request.id,
                        error: {
                            code: Number.isSafeInteger(e?.code) ? (e.code as number) : ProtocolErrorCode.InternalError,
                            message: e?.message ?? 'Internal error',
                            ...(e?.data !== undefined && { data: e.data })
                        }
                    }
                };
                return;
            }
        }

        const relatedTaskId = taskResult.taskContext?.id;
        const taskEnv: DispatchEnv = {
            ...env,
            task: taskResult.taskContext ?? env.task,
            send: (r, opts) => taskResult.sendRequest(r, getResultSchema(r.method as RequestMethod), opts) as Promise<Result>
        };

        // Queued task messages delivered via host.sendOnResponseStream are routed to this
        // generator (instead of `_driver.pipe.send`) so they yield on the same stream.
        const sideQueue: JSONRPCMessage[] = [];
        let wake: (() => void) | undefined;
        this._dispatchYielders.set(request.id, msg => {
            sideQueue.push(msg);
            wake?.();
        });

        const drain = function* (): Generator<DispatchOutput> {
            while (sideQueue.length > 0) {
                const msg = sideQueue.shift()!;
                yield 'method' in msg
                    ? { kind: 'notification', message: msg as JSONRPCNotification }
                    : { kind: 'response', message: msg as JSONRPCResponse | JSONRPCErrorResponse };
            }
        };

        try {
            const inner = super.dispatch(request, taskEnv);
            let pending: Promise<IteratorResult<DispatchOutput>> | undefined;

            while (true) {
                yield* drain();
                pending ??= inner.next();
                const wakeP = new Promise<'side'>(resolve => {
                    wake = () => resolve('side');
                });
                if (sideQueue.length > 0) {
                    wake = undefined;
                    continue;
                }
                const r = await Promise.race([pending, wakeP]);
                wake = undefined;
                if (r === 'side') continue;
                pending = undefined;
                if (r.done) break;
                const out = r.value;
                if (out.kind === 'response') {
                    const routed = await taskResult.routeResponse(out.message);
                    if (!routed) {
                        yield* drain();
                        yield out;
                    }
                } else if (relatedTaskId === undefined) {
                    yield out;
                } else {
                    const params = (out.message.params ?? {}) as Record<string, unknown>;
                    yield {
                        kind: 'notification',
                        message: {
                            ...out.message,
                            params: {
                                ...params,
                                _meta: { ...(params._meta as object), [RELATED_TASK_META_KEY]: { taskId: relatedTaskId } }
                            }
                        }
                    };
                }
            }
            yield* drain();
        } finally {
            this._dispatchYielders.delete(request.id);
        }
    }

    /**
     * Routes an incoming JSON-RPC response (e.g. a client's reply to an `elicitation/create`
     * request the server issued) to the {@linkcode TaskManager} resolver chain.
     * Called by {@linkcode shttpHandler} for response-typed POST bodies.
     *
     * @returns true if the response was consumed.
     */
    dispatchInboundResponse(response: JSONRPCResponse | JSONRPCErrorResponse): boolean {
        const id = typeof response.id === 'number' ? response.id : Number(response.id);
        return this._taskManager.processInboundResponse(response, id).consumed;
    }

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
     *
     * Transports that expose a `bind(server)` method (request-shaped transports like
     * {@linkcode WebStandardStreamableHTTPServerTransport}) are bound to this server
     * first so their `handleRequest` can dispatch directly via {@linkcode shttpHandler};
     * the {@linkcode StreamDriver} is still built so outbound `notification()`/`request()`
     * route through `transport.send()`.
     */
    async connect(transport: Transport): Promise<void> {
        if ('bind' in transport && typeof (transport as { bind: unknown }).bind === 'function') {
            (transport as { bind: (server: McpServer) => void }).bind(this);
        }
        const driverOpts: StreamDriverOptions = {
            supportedProtocolVersions: this._supportedProtocolVersions,
            debouncedNotificationMethods: this._options?.debouncedNotificationMethods,
            taskManager: this._taskManager,
            dispatcherHandlesTasks: true,
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
                const yielder = relatedRequestId === undefined ? undefined : this._dispatchYielders.get(relatedRequestId);
                if (yielder) {
                    yielder(msg);
                    return;
                }
                await this._driver?.pipe.send(msg, { relatedRequestId });
            },
            enforceStrictCapabilities: this._options?.enforceStrictCapabilities === true,
            assertTaskCapability: m => assertClientRequestTaskCapability(this._clientCapabilities?.tasks?.requests, m, 'Client'),
            assertTaskHandlerCapability: m => assertToolsCallTaskCapability(this._capabilities?.tasks?.requests, m, 'Server')
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
                log: (level, data, logger) => base.mcpReq.notify({ method: 'notifications/message', params: { level, data, logger } }),
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
    public override setRequestHandler<S extends StandardSchemaV1>(
        method: string,
        paramsSchema: S,
        handler: (params: StandardSchemaV1.InferOutput<S>, ctx: ServerContext) => Result | Promise<Result>
    ): void;
    /** @deprecated Pass a method string instead of a Zod request schema. */
    public override setRequestHandler<S extends { shape: { method: unknown } }>(
        schema: S,
        handler: (
            request: S extends StandardSchemaV1<unknown, infer O> ? O : JSONRPCRequest,
            ctx: ServerContext
        ) => Result | Promise<Result>
    ): void;
    public override setRequestHandler(
        methodOrSchema: string | { shape: { method: unknown } },
        handlerOrSchema: unknown,
        maybeHandler?: (params: unknown, ctx: ServerContext) => Result | Promise<Result>
    ): void {
        if (maybeHandler !== undefined) {
            const method = methodOrSchema as string;
            assertRequestHandlerCapability(method as RequestMethod, this._capabilities);
            this.setRawRequestHandler(method, this._wrapParamsSchemaHandler(method, handlerOrSchema as StandardSchemaV1, maybeHandler));
            return;
        }
        const handler = handlerOrSchema as (request: never, ctx: ServerContext) => Result | Promise<Result>;
        const method = (typeof methodOrSchema === 'string' ? methodOrSchema : extractMethodFromSchema(methodOrSchema)) as RequestMethod;
        assertRequestHandlerCapability(method, this._capabilities);
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
            assertCapabilityForMethod(req.method as RequestMethod, this._clientCapabilities);
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
        assertNotificationCapability(notification.method as NotificationMethod, this._capabilities, this._clientCapabilities);
        await this._driver?.notification(notification, options);
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
    // Registries (delegated to ServerRegistries)
    // ───────────────────────────────────────────────────────────────────────

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
        return this._registries.registerTool(name, config, cb);
    }

    /**
     * Registers a prompt with a config object and callback.
     */
    registerPrompt<Args extends StandardSchemaWithJSON>(
        name: string,
        config: { title?: string; description?: string; argsSchema?: Args | ZodRawShapeCompat; _meta?: Record<string, unknown> },
        cb: PromptCallback<Args>
    ): RegisteredPrompt {
        return this._registries.registerPrompt(name, config, cb);
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
        return this._registries.registerResource(name, uriOrTemplate as never, config, readCallback as never);
    }

    // ───────────────────────────────────────────────────────────────────────
    // v1-internal compat surface — for code that monkey-patches McpServer
    // private methods (e.g., shortcut's CustomMcpServer overrides
    // setToolRequestHandlers). Routed through here so instance overrides fire.
    // ───────────────────────────────────────────────────────────────────────

    /** @hidden v1 compat: lazy installer hook, override on instance to customize tools/* handlers. */
    setToolRequestHandlers(): void {
        this._registries.setToolRequestHandlers();
    }
    /** @hidden v1 compat */
    setResourceRequestHandlers(): void {
        this._registries.setResourceRequestHandlers();
    }
    /** @hidden v1 compat */
    setPromptRequestHandlers(): void {
        this._registries.setPromptRequestHandlers();
    }
    /** @hidden v1 compat */
    setCompletionRequestHandler(): void {
        this._registries.setCompletionRequestHandler();
    }
    /** @hidden v1 compat */
    protected validateToolInput(tool: RegisteredTool, args: unknown, toolName: string) {
        return this._registries.validateToolInput(tool, args as never, toolName);
    }
    /** @hidden v1 compat */
    protected validateToolOutput(tool: RegisteredTool, result: CallToolResult | CreateTaskResult, toolName: string) {
        return this._registries.validateToolOutput(tool, result, toolName);
    }
    /** @hidden v1 compat */
    protected handleAutomaticTaskPolling(tool: RegisteredTool, request: CallToolRequest, ctx: ServerContext) {
        return this._registries.handleAutomaticTaskPolling(tool, request, ctx);
    }
    /** @hidden v1 compat: was a private instance method in v1 mcp.ts. */
    protected createToolError(errorMessage: string): CallToolResult {
        return { content: [{ type: 'text', text: errorMessage }], isError: true };
    }
    /** @hidden v1 compat: removed in v2 (replaced by `tool.executor`); shim calls executor. */
    protected executeToolHandler(tool: RegisteredTool, args: unknown, ctx: ServerContext) {
        return tool.executor(args as never, ctx);
    }

    /** @hidden v1 compat for `(mcpServer as any)._registeredTools` and `experimental.tasks`. */
    get _registeredTools(): { [name: string]: RegisteredTool } {
        return this._registries.registeredTools;
    }
    /** @hidden v1 compat. */
    get _registeredResources(): { [uri: string]: RegisteredResource } {
        return this._registries.registeredResources;
    }
    /** @hidden v1 compat. */
    get _registeredResourceTemplates(): { [name: string]: RegisteredResourceTemplate } {
        return this._registries.registeredResourceTemplates;
    }
    /** @hidden v1 compat. */
    get _registeredPrompts(): { [name: string]: RegisteredPrompt } {
        return this._registries.registeredPrompts;
    }

    /** @hidden v1 compat for `experimental.tasks.registerToolTask` which calls this directly. */
    _createRegisteredTool(
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
        return this._registries.createRegisteredTool(
            name,
            title,
            description,
            inputSchema,
            outputSchema,
            annotations,
            execution,
            _meta,
            handler
        );
    }

    // ───────────────────────────────────────────────────────────────────────
    // Deprecated v1 overloads (positional, raw-shape) — call register* internally
    // ───────────────────────────────────────────────────────────────────────

    /** @deprecated Use {@linkcode McpServer.registerTool | registerTool()} instead. */
    tool(name: string, cb: ToolCallback): RegisteredTool;
    /** @deprecated Use {@linkcode McpServer.registerTool | registerTool()} instead. */
    tool(name: string, description: string, cb: ToolCallback): RegisteredTool;
    /** @deprecated Use {@linkcode McpServer.registerTool | registerTool()} instead. */
    tool<Args extends ZodRawShapeCompat>(
        name: string,
        paramsSchemaOrAnnotations: Args | ToolAnnotations,
        cb: LegacyToolCallback<Args>
    ): RegisteredTool;
    /** @deprecated Use {@linkcode McpServer.registerTool | registerTool()} instead. */
    tool<Args extends ZodRawShapeCompat>(
        name: string,
        description: string,
        paramsSchemaOrAnnotations: Args | ToolAnnotations,
        cb: LegacyToolCallback<Args>
    ): RegisteredTool;
    /** @deprecated Use {@linkcode McpServer.registerTool | registerTool()} instead. */
    tool<Args extends ZodRawShapeCompat>(
        name: string,
        paramsSchema: Args,
        annotations: ToolAnnotations,
        cb: LegacyToolCallback<Args>
    ): RegisteredTool;
    /** @deprecated Use {@linkcode McpServer.registerTool | registerTool()} instead. */
    tool<Args extends ZodRawShapeCompat>(
        name: string,
        description: string,
        paramsSchema: Args,
        annotations: ToolAnnotations,
        cb: LegacyToolCallback<Args>
    ): RegisteredTool;
    tool(name: string, ...rest: unknown[]): RegisteredTool {
        if (this._registries.registeredTools[name]) throw new Error(`Tool ${name} is already registered`);
        const { description, inputSchema, annotations, cb } = parseLegacyToolArgs(name, rest);
        return this._registries.createRegisteredTool(
            name,
            undefined,
            description,
            inputSchema,
            undefined,
            annotations,
            { taskSupport: 'forbidden' },
            undefined,
            cb as ToolCallback<StandardSchemaWithJSON | undefined>
        );
    }

    /** @deprecated Use {@linkcode McpServer.registerPrompt | registerPrompt()} instead. */
    prompt(name: string, cb: PromptCallback): RegisteredPrompt;
    /** @deprecated Use {@linkcode McpServer.registerPrompt | registerPrompt()} instead. */
    prompt(name: string, description: string, cb: PromptCallback): RegisteredPrompt;
    /** @deprecated Use {@linkcode McpServer.registerPrompt | registerPrompt()} instead. */
    prompt<Args extends ZodRawShapeCompat>(name: string, argsSchema: Args, cb: LegacyPromptCallback<Args>): RegisteredPrompt;
    /** @deprecated Use {@linkcode McpServer.registerPrompt | registerPrompt()} instead. */
    prompt<Args extends ZodRawShapeCompat>(
        name: string,
        description: string,
        argsSchema: Args,
        cb: LegacyPromptCallback<Args>
    ): RegisteredPrompt;
    prompt(name: string, ...rest: unknown[]): RegisteredPrompt {
        if (this._registries.registeredPrompts[name]) throw new Error(`Prompt ${name} is already registered`);
        const { description, argsSchema, cb } = parseLegacyPromptArgs(rest);
        const r = this._registries.createRegisteredPrompt(
            name,
            undefined,
            description,
            argsSchema,
            cb as PromptCallback<StandardSchemaWithJSON | undefined>,
            undefined
        );
        this._registries.installPromptHandlers();
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
    resource(
        name: string,
        template: ResourceTemplate,
        metadata: ResourceMetadata,
        readCallback: ReadResourceTemplateCallback
    ): RegisteredResourceTemplate;
    resource(name: string, uriOrTemplate: string | ResourceTemplate, ...rest: unknown[]): RegisteredResource | RegisteredResourceTemplate {
        let metadata: ResourceMetadata | undefined;
        if (typeof rest[0] === 'object') metadata = rest.shift() as ResourceMetadata;
        const readCallback = rest[0] as ReadResourceCallback | ReadResourceTemplateCallback;
        if (typeof uriOrTemplate === 'string') {
            if (this._registries.registeredResources[uriOrTemplate]) throw new Error(`Resource ${uriOrTemplate} is already registered`);
            const r = this._registries.createRegisteredResource(
                name,
                undefined,
                uriOrTemplate,
                metadata,
                readCallback as ReadResourceCallback
            );
            this._registries.installResourceHandlers();
            this.sendResourceListChanged();
            return r;
        }
        if (this._registries.registeredResourceTemplates[name]) throw new Error(`Resource template ${name} is already registered`);
        const r = this._registries.createRegisteredResourceTemplate(
            name,
            undefined,
            uriOrTemplate,
            metadata,
            readCallback as ReadResourceTemplateCallback
        );
        this._registries.installResourceHandlers();
        this.sendResourceListChanged();
        return r;
    }
}

function jsonResponse(status: number, body: unknown): Response {
    return Response.json(body, { status, headers: { 'content-type': 'application/json' } });
}

// ───────────────────────────────────────────────────────────────────────────
// Re-exports for path compat. External code imports these from './mcpServer.js'.
// ───────────────────────────────────────────────────────────────────────────

export type { CompleteResourceTemplateCallback, ListResourcesCallback } from './resourceTemplate.js';
export { ResourceTemplate } from './resourceTemplate.js';
export type {
    AnyToolHandler,
    BaseToolCallback,
    PromptCallback,
    ReadResourceCallback,
    ReadResourceTemplateCallback,
    RegisteredPrompt,
    RegisteredResource,
    RegisteredResourceTemplate,
    RegisteredTool,
    ResourceMetadata,
    ToolCallback
} from './serverRegistries.js';
