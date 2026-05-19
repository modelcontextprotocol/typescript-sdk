import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/client/_shims';
import type {
    BaseContext,
    CallToolRequest,
    ClientCapabilities,
    ClientContext,
    CompleteRequest,
    GetPromptRequest,
    Implementation,
    InputRequiredResult,
    JSONRPCMessage,
    JSONRPCNotification,
    JsonSchemaType,
    JsonSchemaValidator,
    jsonSchemaValidator,
    ListChangedHandlers,
    ListChangedOptions,
    ListPromptsRequest,
    ListResourcesRequest,
    ListResourceTemplatesRequest,
    ListToolsRequest,
    LoggingLevel,
    MessageExtraInfo,
    Middleware,
    NotificationMethod,
    Progress,
    ProgressToken,
    ProtocolOptions,
    ReadResourceRequest,
    RequestMethod,
    RequestOptions,
    ServerCapabilities,
    StandardSchemaV1,
    SubscribeRequest,
    SubscriptionFilter,
    Tool,
    Transport,
    UnsubscribeRequest
} from '@modelcontextprotocol/core';
import {
    CallToolResultSchema,
    CompleteResultSchema,
    CreateMessageRequestSchema,
    CreateMessageResultSchema,
    CreateMessageResultWithToolsSchema,
    DEFAULT_REQUEST_TIMEOUT_MSEC,
    DiscoverResultSchema,
    ElicitRequestSchema,
    ElicitResultSchema,
    EmptyResultSchema,
    GetPromptResultSchema,
    InitializeResultSchema,
    InputRequiredResultSchema,
    isJSONRPCErrorResponse,
    isJSONRPCNotification,
    isJSONRPCResultResponse,
    isStatelessProtocolVersion,
    JSONRPC_VERSION,
    LATEST_PROTOCOL_VERSION,
    ListChangedOptionsBaseSchema,
    ListPromptsResultSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesResultSchema,
    ListToolsResultSchema,
    mergeCapabilities,
    META_KEYS,
    parseSchema,
    Protocol,
    ProtocolError,
    ProtocolErrorCode,
    ReadResourceResultSchema,
    SdkError,
    SdkErrorCode
} from '@modelcontextprotocol/core';

const MRTR_MAX_ROUNDS = 16;
const MAX_INPUT_REQUESTS_PER_ROUND = 16;

/** Only these methods may appear as `inputRequests` (defense-in-depth; schema also constrains). */
const MRTR_INPUT_METHODS: ReadonlySet<string> = new Set(['sampling/createMessage', 'elicitation/create', 'roots/list']);

type ListChangedKinds = Record<
    string,
    {
        filterKey: Exclude<keyof SubscriptionFilter, 'resourceSubscriptions'>;
        config: ListChangedOptions<unknown>;
        fetcher: () => Promise<unknown[]>;
        autoRefresh: boolean;
        debounceMs?: number;
    }
>;

/**
 * Returns true for `server/discover` failures that should fall through to the
 * legacy `initialize` handshake (server doesn't speak 2026-06).
 */
function isFallbackable(e: unknown): boolean {
    if (e instanceof ProtocolError) {
        return e.code === ProtocolErrorCode.MethodNotFound;
    }
    if (e instanceof SdkError) {
        const status = (e.data as { status?: number } | undefined)?.status;
        return e.code === SdkErrorCode.InvalidResult || (typeof status === 'number' && status >= 400 && status < 500);
    }
    return false;
}

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

        this.dispatcher.use(this._validationMiddleware);

        // Store list changed config for setup after connection (when we know server capabilities)
        if (options?.listChanged) {
            this._pendingListChangedConfig = options.listChanged;
        }
    }

    protected override buildContext(ctx: BaseContext, _transportInfo?: MessageExtraInfo): ClientContext {
        return ctx;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 2026 stateless (SEP-2575/2322)
    // ═══════════════════════════════════════════════════════════════════════

    /** Set true by {@linkcode _negotiate} when `server/discover` succeeds. */
    private _isStateless = false;

    /** Log level included in per-request `_meta` (set by {@linkcode setLoggingLevel}). */
    private _logLevel?: LoggingLevel;

    /**
     * Builds the namespaced `_meta` object this client sends on every 2026-06
     * request: protocol version, client identity, capabilities, log level.
     */
    private _buildMeta(version?: string): Record<string, unknown> {
        const meta: Record<string, unknown> = {
            [META_KEYS.protocolVersion]: version ?? this._negotiatedProtocolVersion,
            [META_KEYS.clientInfo]: this._clientInfo,
            [META_KEYS.clientCapabilities]: this._capabilities
        };
        if (this._logLevel !== undefined) meta[META_KEYS.logLevel] = this._logLevel;
        return meta;
    }

    /**
     * Merges {@linkcode _buildMeta} + `extra` into `params._meta`. Caller-supplied
     * `params._meta` keys take precedence over the namespaced identity keys, but
     * SDK-set `extra` (e.g. the correlation `progressToken`) is spread last so it
     * always wins, matching {@linkcode Protocol.request}.
     */
    private _withMeta(params: Record<string, unknown> | undefined, extra?: Record<string, unknown>): Record<string, unknown> {
        return { ...params, _meta: { ...this._buildMeta(), ...(params?._meta as object | undefined), ...extra } };
    }

    /**
     * Drains a `sendAndReceive` async iterable: routes `notifications/progress`
     * with the matching token to `opts.onprogress`, routes any other
     * notification through {@linkcode _onnotification} so registered handlers
     * fire, parses and returns the first response, throws on JSON-RPC error.
     */
    private async _collect(
        it: AsyncIterable<JSONRPCMessage>,
        opts?: { signal?: AbortSignal; onprogress?: (p: Progress) => void; progressToken?: ProgressToken }
    ): Promise<Record<string, unknown>> {
        for await (const m of it) {
            opts?.signal?.throwIfAborted();
            if (isJSONRPCErrorResponse(m)) {
                throw new ProtocolError(m.error.code, m.error.message, m.error.data);
            }
            if (isJSONRPCResultResponse(m)) {
                return m.result;
            }
            if (isJSONRPCNotification(m)) {
                if (
                    m.method === 'notifications/progress' &&
                    opts?.onprogress &&
                    (m.params as { progressToken?: ProgressToken }).progressToken === opts.progressToken
                ) {
                    opts.onprogress(m.params as Progress);
                } else {
                    // Route other notifications (e.g. notifications/message) through
                    // Protocol's _onnotification so any handler registered via
                    // setNotificationHandler fires, with the fallback as last resort.
                    this._onnotification(m);
                }
            }
            // Anything else (e.g. a stray request) is ignored.
        }
        if (opts?.signal?.aborted) throw opts.signal.reason ?? new DOMException('Aborted', 'AbortError');
        throw new SdkError(SdkErrorCode.ConnectionClosed, 'Stream ended without a response');
    }

    /**
     * Routes one client-to-server request. When not stateless (or transport
     * lacks `sendAndReceive`), delegates to {@linkcode Protocol.request | request()}.
     * Otherwise sends via `sendAndReceive` and runs the MRTR resume loop:
     * on `resultType: 'input_required'`, dispatch each input request through
     * `this.dispatcher.dispatch` (so {@linkcode _validationMiddleware} runs),
     * accumulate `inputResponses` + thread `requestState`, re-send.
     */
    private async _send<T extends StandardSchemaV1>(
        request: { method: string; params?: Record<string, unknown> },
        schema: T,
        options?: RequestOptions
    ): Promise<StandardSchemaV1.InferOutput<T>> {
        const sar = this.transport?.sendAndReceive?.bind(this.transport);
        if (!this._isStateless || !sar) {
            return this._requestWithSchema(request, schema, options);
        }
        if (this._enforceStrictCapabilities) {
            this.assertCapabilityForMethod(request.method);
        }

        const progressToken: ProgressToken | undefined = options?.onprogress ? crypto.randomUUID() : undefined;
        const accumulated: Record<string, unknown> = {};
        let requestState: string | undefined;

        // Compose `options.signal` + `options.maxTotalTimeout` + a resettable
        // per-request `options.timeout` (default 60s, same as Protocol.request)
        // into one signal. `resetTimeoutOnProgress` resets the per-request timer
        // when progress arrives; `maxTotalTimeout` is never reset.
        const timeoutMs = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
        const timeoutCtl = new AbortController();
        const armTimeout = () =>
            setTimeout(
                () => timeoutCtl.abort(new SdkError(SdkErrorCode.RequestTimeout, 'Request timed out', { timeout: timeoutMs })),
                timeoutMs
            );
        let timeoutHandle = armTimeout();
        const onprogress = (p: Progress) => {
            if (options?.resetTimeoutOnProgress) {
                clearTimeout(timeoutHandle);
                timeoutHandle = armTimeout();
            }
            options?.onprogress?.(p);
        };
        const parts: AbortSignal[] = [timeoutCtl.signal];
        if (options?.signal) parts.push(options.signal);
        if (options?.maxTotalTimeout !== undefined) parts.push(AbortSignal.timeout(options.maxTotalTimeout));
        const signal = parts.length === 1 ? parts[0]! : AbortSignal.any(parts);

        try {
            for (let round = 0; round < MRTR_MAX_ROUNDS; round++) {
                signal.throwIfAborted();
                // SEP-2322: inputResponses + requestState are params-level fields
                // (spec InputResponseRequestParams), not _meta keys.
                const params: Record<string, unknown> = { ...request.params };
                if (Object.keys(accumulated).length > 0) params.inputResponses = accumulated;
                if (requestState !== undefined) params.requestState = requestState;
                const metaExtra = progressToken === undefined ? undefined : { progressToken };

                const raw = await this._collect(sar({ method: request.method, params: this._withMeta(params, metaExtra) }, { signal }), {
                    signal,
                    onprogress,
                    progressToken
                });

                if (raw.resultType !== 'input_required') {
                    const parsed = await schema['~standard'].validate(raw);
                    if (parsed.issues) {
                        throw new SdkError(SdkErrorCode.InvalidResult, `Invalid result: ${JSON.stringify(parsed.issues)}`);
                    }
                    return parsed.value;
                }
                const ir = InputRequiredResultSchema.parse(raw) as InputRequiredResult;
                requestState = ir.requestState;
                const entries = Object.entries(ir.inputRequests ?? {});
                if (entries.length > MAX_INPUT_REQUESTS_PER_ROUND) {
                    throw new SdkError(
                        SdkErrorCode.InvalidResult,
                        `Too many input requests (${entries.length}); server may issue at most ${MAX_INPUT_REQUESTS_PER_ROUND} per round`
                    );
                }
                for (const [key, irq] of entries) {
                    signal.throwIfAborted();
                    if (!MRTR_INPUT_METHODS.has(irq.method)) {
                        throw new SdkError(SdkErrorCode.InvalidResult, `inputRequests['${key}'].method '${irq.method}' is not allowed`);
                    }
                    // Dispatch through the same middleware chain as legacy
                    // server-to-client requests so _validationMiddleware applies.
                    const ctx = this.buildContext({
                        sessionId: undefined,
                        mcpReq: {
                            id: key,
                            method: irq.method,
                            signal,
                            send: (() => {
                                throw new SdkError(SdkErrorCode.CapabilityNotSupported, 'send is not available inside MRTR input handlers');
                            }) as ClientContext['mcpReq']['send'],
                            notify: async () => {}
                        }
                    });
                    const res = await this.dispatcher.dispatch(
                        { jsonrpc: JSONRPC_VERSION, id: key, method: irq.method, params: irq.params as Record<string, unknown> },
                        ctx
                    );
                    if ('error' in res) {
                        throw new ProtocolError(res.error.code, res.error.message, res.error.data);
                    }
                    accumulated[key] = res.result;
                }
            }
            throw new SdkError(SdkErrorCode.RequestTimeout, `MRTR exceeded ${MRTR_MAX_ROUNDS} rounds for ${request.method}`);
        } finally {
            clearTimeout(timeoutHandle);
        }
    }

    /**
     * Probes `server/discover` via `transport.sendAndReceive`. On success,
     * marks this client stateless and populates server identity/capabilities
     * from the result. On {@linkcode isFallbackable} failure, leaves state
     * untouched (the legacy `initialize` already populated it via `connect()`).
     *
     * Called from {@linkcode connect} (in C13).
     */
    private async _negotiate(transport: Transport): Promise<void> {
        const sar = transport.sendAndReceive?.bind(transport);
        const preferred = this._supportedProtocolVersions.find(v => isStatelessProtocolVersion(v));
        if (!sar || !preferred) return;

        transport.setProtocolVersion?.(preferred);
        try {
            const raw = await this._collect(sar({ method: 'server/discover', params: { _meta: this._buildMeta(preferred) } }));
            const dr = DiscoverResultSchema.parse(raw);
            const negotiated = dr.supportedVersions.find(v => this._supportedProtocolVersions.includes(v));
            if (negotiated && isStatelessProtocolVersion(negotiated)) {
                this._serverCapabilities = dr.capabilities;
                this._serverVersion = dr.serverInfo;
                this._instructions = dr.instructions;
                this._negotiatedProtocolVersion = negotiated;
                this._isStateless = true;
                transport.setProtocolVersion?.(negotiated);
                return;
            }
        } catch (error) {
            if (!isFallbackable(error)) throw error;
        }
        // Reset header to whatever legacy initialize set.
        transport.setProtocolVersion?.(this._negotiatedProtocolVersion ?? '');
    }

    /**
     * Opens a `subscriptions/listen` stream and yields each notification.
     * Throws unless this client negotiated stateless mode and the transport
     * supports `sendAndReceive`. Breaking out of the loop (or aborting the
     * signal) cancels the underlying transport stream, which the server treats
     * as unsubscribe.
     */
    async *subscribe(filter: SubscriptionFilter, opts?: { signal?: AbortSignal }): AsyncGenerator<JSONRPCNotification, void, void> {
        const sar = this.transport?.sendAndReceive?.bind(this.transport);
        if (!this._isStateless || !sar) {
            throw new SdkError(
                SdkErrorCode.CapabilityNotSupported,
                'subscribe() requires a stateless protocol version and a transport that supports sendAndReceive'
            );
        }
        for await (const m of sar(
            { method: 'subscriptions/listen', params: this._withMeta({ notifications: filter }) },
            { signal: opts?.signal }
        )) {
            if (isJSONRPCNotification(m)) {
                yield m;
            } else if (isJSONRPCErrorResponse(m)) {
                throw new ProtocolError(m.error.code, m.error.message, m.error.data);
            }
        }
    }

    private _listChangedAbort?: AbortController;

    /**
     * Stateless backing for `options.listChanged`: opens ONE
     * `subscriptions/listen` for all configured list-changed kinds and calls
     * the matching `onChanged` per notification (debounced by `debounceMs`).
     */
    private async _listChangedLoop(kinds: ListChangedKinds): Promise<void> {
        const filter: SubscriptionFilter = {};
        const debounced: Record<string, () => void> = {};
        const timers = new Map<string, ReturnType<typeof setTimeout>>();
        for (const [method, k] of Object.entries(kinds)) {
            filter[k.filterKey] = true;
            const { autoRefresh, debounceMs } = k;
            const refresh = async () => {
                if (!autoRefresh) {
                    k.config.onChanged(null, null);
                    return;
                }
                try {
                    k.config.onChanged(null, await k.fetcher());
                } catch (error) {
                    k.config.onChanged(error instanceof Error ? error : new Error(String(error)), null);
                }
            };
            // eslint-disable-next-line unicorn/consistent-function-scoping -- closes over per-iteration `refresh`
            const run = () =>
                void refresh().catch(error => (this.onerror ?? console.error)(error instanceof Error ? error : new Error(String(error))));
            debounced[method] = debounceMs
                ? () => {
                      const t = timers.get(method);
                      if (t) clearTimeout(t);
                      timers.set(method, setTimeout(run, debounceMs));
                  }
                : run;
        }
        this._listChangedAbort?.abort();
        this._listChangedAbort = new AbortController();
        const { signal } = this._listChangedAbort;
        try {
            for await (const n of this.subscribe(filter, { signal })) {
                debounced[n.method]?.();
            }
            // Stream ended without error and without our abort: surface so the
            // caller knows list-changed delivery has stopped.
            if (!signal.aborted) {
                throw new SdkError(SdkErrorCode.ConnectionClosed, 'subscriptions/listen stream ended');
            }
        } finally {
            for (const t of timers.values()) clearTimeout(t);
            timers.clear();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // dual-mode (SEP-2575/2567)
    //
    // `connect()` probes `server/discover` then falls back to legacy
    // `initialize`. `_setupListChanged()` and `setLoggingLevel()` branch on
    // `_isStateless`. Typed request methods (callTool/listTools/etc.) route
    // via `_send`, which falls back to `Protocol.request()` when not
    // stateless. These methods appear inline below among session-dependent
    // code for diff-minimality; the dual-mode set is: connect, close,
    // _initialize, _setupListChanged, setLoggingLevel, callTool, listTools,
    // getPrompt, listPrompts, readResource, listResources,
    // listResourceTemplates, complete.
    // ═══════════════════════════════════════════════════════════════════════

    override async close(): Promise<void> {
        this._isStateless = false;
        this._listChangedAbort?.abort();
        this._listChangedAbort = undefined;
        await super.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // session-dependent (existing — bodies unchanged unless noted dual-mode above)
    //
    // `connect()` performs the legacy `initialize` handshake. The 2026-06
    // discover auto-probe is wired in C13. `ping`, `subscribeResource`,
    // `unsubscribeResource`, and `_setupListChangedHandler*` use the
    // persistent connection; `_listChangedLoop` (above) is the 2026 path.
    // ═══════════════════════════════════════════════════════════════════════

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
            if (this._negotiatedProtocolVersion !== undefined && transport.setProtocolVersion) {
                transport.setProtocolVersion(this._negotiatedProtocolVersion);
            }
            return;
        }
        try {
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
     * Legacy `initialize` handshake; called from {@linkcode connect} when the
     * 2026-06 discover probe is unavailable or falls back.
     */
    private async _initialize(transport: Transport, options?: RequestOptions): Promise<void> {
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
     * Wires `options.listChanged` after capabilities are known. Stateless
     * connections use `subscriptions/listen` ({@linkcode _listChangedLoop});
     * legacy connections register notification handlers.
     */
    private _setupListChanged(): void {
        const config = this._pendingListChangedConfig;
        if (!config) return;
        if (!this._isStateless) {
            this._pendingListChangedConfig = undefined;
            this._setupListChangedHandlers(config);
            return;
        }
        const kinds: ListChangedKinds = {};
        const add = <T>(
            method: string,
            filterKey: Exclude<keyof SubscriptionFilter, 'resourceSubscriptions'>,
            cfg: ListChangedOptions<T>,
            fetcher: () => Promise<T[]>
        ): void => {
            const parsed = parseSchema(ListChangedOptionsBaseSchema, cfg);
            if (!parsed.success) throw new Error(`Invalid ${String(filterKey)} listChanged options: ${parsed.error.message}`);
            kinds[method] = { filterKey, config: cfg as ListChangedOptions<unknown>, fetcher, ...parsed.data };
        };
        if (config.tools && this._serverCapabilities?.tools?.listChanged) {
            add('notifications/tools/list_changed', 'toolsListChanged', config.tools, () => this.listTools().then(r => r.tools));
        }
        if (config.prompts && this._serverCapabilities?.prompts?.listChanged) {
            add('notifications/prompts/list_changed', 'promptsListChanged', config.prompts, () => this.listPrompts().then(r => r.prompts));
        }
        if (config.resources && this._serverCapabilities?.resources?.listChanged) {
            add('notifications/resources/list_changed', 'resourcesListChanged', config.resources, () =>
                this.listResources().then(r => r.resources)
            );
        }
        if (Object.keys(kinds).length > 0) {
            this._listChangedLoop(kinds).catch(error =>
                (this.onerror ?? console.error)(error instanceof Error ? error : new Error(String(error)))
            );
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
        return this._requestWithSchema({ method: 'ping' }, EmptyResultSchema, options);
    }

    /** Requests argument autocompletion suggestions from the server for a prompt or resource. */
    async complete(params: CompleteRequest['params'], options?: RequestOptions) {
        return this._send({ method: 'completion/complete', params }, CompleteResultSchema, options);
    }

    /**
     * Sets the minimum severity level for log messages sent by the server.
     * Stored locally for per-request `_meta.logLevel`; when not stateless,
     * also sends the legacy `logging/setLevel` RPC.
     */
    async setLoggingLevel(level: LoggingLevel, options?: RequestOptions) {
        this._logLevel = level;
        if (this._isStateless) return {};
        return this._requestWithSchema({ method: 'logging/setLevel', params: { level } }, EmptyResultSchema, options);
    }

    /** Retrieves a prompt by name from the server, passing the given arguments for template substitution. */
    async getPrompt(params: GetPromptRequest['params'], options?: RequestOptions) {
        return this._send({ method: 'prompts/get', params }, GetPromptResultSchema, options);
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
    async listPrompts(params?: ListPromptsRequest['params'], options?: RequestOptions) {
        if (!this._serverCapabilities?.prompts && !this._enforceStrictCapabilities) {
            // Respect capability negotiation: server does not support prompts
            console.debug('Client.listPrompts() called but server does not advertise prompts capability - returning empty list');
            return { prompts: [] };
        }
        return this._send({ method: 'prompts/list', params }, ListPromptsResultSchema, options);
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
    async listResources(params?: ListResourcesRequest['params'], options?: RequestOptions) {
        if (!this._serverCapabilities?.resources && !this._enforceStrictCapabilities) {
            // Respect capability negotiation: server does not support resources
            console.debug('Client.listResources() called but server does not advertise resources capability - returning empty list');
            return { resources: [] };
        }
        return this._send({ method: 'resources/list', params }, ListResourcesResultSchema, options);
    }

    /**
     * Lists available resource URI templates for dynamic resources. Results may be paginated — see {@linkcode listResources | listResources()} for the cursor pattern.
     *
     * Returns an empty list if the server does not advertise resources capability
     * (or throws if {@linkcode ClientOptions.enforceStrictCapabilities} is enabled).
     */
    async listResourceTemplates(params?: ListResourceTemplatesRequest['params'], options?: RequestOptions) {
        if (!this._serverCapabilities?.resources && !this._enforceStrictCapabilities) {
            // Respect capability negotiation: server does not support resources
            console.debug(
                'Client.listResourceTemplates() called but server does not advertise resources capability - returning empty list'
            );
            return { resourceTemplates: [] };
        }
        return this._send({ method: 'resources/templates/list', params }, ListResourceTemplatesResultSchema, options);
    }

    /** Reads the contents of a resource by URI. */
    async readResource(params: ReadResourceRequest['params'], options?: RequestOptions) {
        return this._send({ method: 'resources/read', params }, ReadResourceResultSchema, options);
    }

    /**
     * Subscribes to change notifications for a resource. The server must support resource subscriptions.
     *
     * @deprecated Use `client.subscribe({ resourceSubscriptions: [uri] })` when connected to a 2026-06 server. This RPC form requires a pre-2026 connection.
     */
    async subscribeResource(params: SubscribeRequest['params'], options?: RequestOptions) {
        return this._requestWithSchema({ method: 'resources/subscribe', params }, EmptyResultSchema, options);
    }

    /**
     * Unsubscribes from change notifications for a resource.
     *
     * @deprecated Use `client.subscribe()` and break out of the loop / abort its signal to stop, when connected to a 2026-06 server. This RPC form requires a pre-2026 connection.
     */
    async unsubscribeResource(params: UnsubscribeRequest['params'], options?: RequestOptions) {
        return this._requestWithSchema({ method: 'resources/unsubscribe', params }, EmptyResultSchema, options);
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
    async callTool(params: CallToolRequest['params'], options?: RequestOptions) {
        const result = await this._send({ method: 'tools/call', params }, CallToolResultSchema, options);

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
    async listTools(params?: ListToolsRequest['params'], options?: RequestOptions) {
        if (!this._serverCapabilities?.tools && !this._enforceStrictCapabilities) {
            // Respect capability negotiation: server does not support tools
            console.debug('Client.listTools() called but server does not advertise tools capability - returning empty list');
            return { tools: [] };
        }
        const result = await this._send({ method: 'tools/list', params }, ListToolsResultSchema, options);

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

    /**
     * Notifies the server that the client's root list has changed. Requires the `roots.listChanged` capability.
     *
     * @deprecated Under the 2026-06 protocol the server polls roots via MRTR; there is no client-to-server notification path. This form requires a pre-2026 connection.
     */
    async sendRootsListChanged() {
        return this.notification({ method: 'notifications/roots/list_changed' });
    }
}
