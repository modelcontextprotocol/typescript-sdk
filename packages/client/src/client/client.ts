import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/client/_shims';
import type {
    CallToolRequest,
    ClientCapabilities,
    ClientContext,
    CompleteRequest,
    GetPromptRequest,
    Handler,
    Implementation,
    InferHandlerResult,
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
    Notification,
    NotificationMethod,
    NotificationTypeMap,
    Progress,
    ProgressToken,
    ReadResourceRequest,
    RequestMethod,
    RequestOptions,
    RequestTypeMap,
    ResultTypeMap,
    ServerCapabilities,
    StandardSchemaV1,
    SubscriptionFilter,
    Tool,
    Transport
} from '@modelcontextprotocol/core';
import {
    CallToolResultSchema,
    CompleteResultSchema,
    DEFAULT_REQUEST_TIMEOUT_MSEC,
    DiscoverResultSchema,
    EmptyResultSchema,
    GetPromptResultSchema,
    InputRequiredResultSchema,
    isJSONRPCErrorResponse,
    isJSONRPCNotification,
    isJSONRPCResultResponse,
    isStatelessProtocolVersion,
    JSONRPC_VERSION,
    ListChangedOptionsBaseSchema,
    ListPromptsResultSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesResultSchema,
    ListToolsResultSchema,
    META_KEYS,
    parseSchema,
    ProtocolError,
    ProtocolErrorCode,
    ReadResourceResultSchema,
    SdkError,
    SdkErrorCode,
    SUPPORTED_PROTOCOL_VERSIONS
} from '@modelcontextprotocol/core';

import type { ClientOptions } from './legacyClient.js';
import { LegacyClient } from './legacyClient.js';

export type { ClientOptions } from './legacyClient.js';
export { getSupportedElicitationModes } from './legacyClient.js';

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
 * legacy `initialize` handshake (server doesn't speak 2026-06). Auth failures
 * (401/403) are NOT fallbackable: a server that requires auth for `discover`
 * will require it for `initialize` too, so falling back would only mask the
 * real error and skip the transport's re-auth path.
 */
function isFallbackable(e: unknown): boolean {
    if (e instanceof ProtocolError) {
        return e.code === ProtocolErrorCode.MethodNotFound;
    }
    if (e instanceof SdkError) {
        const status = (e.data as { status?: number } | undefined)?.status;
        // Any 4xx except 401/403 (auth) means the server doesn't speak 2026-06.
        // 400 in particular is what a pre-2026 StreamableHTTP server returns for
        // a non-initialize POST without an mcp-session-id.
        return (
            e.code === SdkErrorCode.InvalidResult ||
            (typeof status === 'number' && status >= 400 && status < 500 && status !== 401 && status !== 403)
        );
    }
    return false;
}

/**
 * An MCP client on top of a pluggable transport.
 *
 * `Client` does not extend `Protocol`. It owns the 2026-06 stateless send
 * path ({@linkcode subscribe}, `_send`/`_negotiate`/`_collect`) and the typed
 * request methods, and composes a {@linkcode LegacyClient} (reachable via
 * {@linkcode legacy}) for the pre-2026 connection model. Both share one
 * handler registry, so a single `setRequestHandler` call serves
 * server-to-client requests under either protocol era.
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
export class Client {
    /** Static client identity. Client capabilities live on {@linkcode legacy} so `registerCapabilities` stays single-source. */
    readonly config: {
        readonly clientInfo: Implementation;
        readonly supportedProtocolVersions: readonly string[];
    };

    /** Composed pre-2026 implementation; owns the `Protocol` connection + negotiated server state. */
    private readonly _legacy: LegacyClient;

    private readonly _jsonSchemaValidator: jsonSchemaValidator;
    private readonly _enforceStrictCapabilities: boolean;
    private readonly _cachedToolOutputValidators: Map<string, JsonSchemaValidator<unknown>> = new Map();
    private _pendingListChangedConfig?: ListChangedHandlers;

    /**
     * Initializes this client with the given name and version information.
     */
    constructor(clientInfo: Implementation, options?: ClientOptions) {
        this._legacy = new LegacyClient(clientInfo, options);
        this.config = {
            clientInfo,
            supportedProtocolVersions: options?.supportedProtocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS
        };
        this._jsonSchemaValidator = options?.jsonSchemaValidator ?? new DefaultJsonSchemaValidator();
        this._enforceStrictCapabilities = options?.enforceStrictCapabilities ?? false;

        // Store list changed config for setup after connection (when we know server capabilities)
        if (options?.listChanged) {
            this._pendingListChangedConfig = options.listChanged;
        }
    }

    /**
     * Escape hatch to the composed pre-2026 connection-model client (extends
     * `Protocol`). Use for `ping`/`subscribeResource`/`unsubscribeResource`/
     * `sendRootsListChanged`/raw `request`/`notification`/`setNotificationHandler`.
     */
    get legacy(): LegacyClient {
        return this._legacy;
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
            [META_KEYS.protocolVersion]: version ?? this._legacy.getNegotiatedProtocolVersion(),
            [META_KEYS.clientInfo]: this.config.clientInfo,
            [META_KEYS.clientCapabilities]: this._legacy._clientCapabilities
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
     * notification through {@linkcode legacy} so registered handlers fire,
     * parses and returns the first response, throws on JSON-RPC error.
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
                    this._legacy._routeNotification(m);
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
     * `this._legacy._dispatch` (so `_validationMiddleware` runs),
     * accumulate `inputResponses` + thread `requestState`, re-send.
     */
    private async _send<T extends StandardSchemaV1>(
        request: { method: string; params?: Record<string, unknown> },
        schema: T,
        options?: RequestOptions
    ): Promise<StandardSchemaV1.InferOutput<T>> {
        const sar = this.transport?.sendAndReceive?.bind(this.transport);
        if (!this._isStateless || !sar) {
            return this._legacy.request(request, schema, options);
        }
        if (this._enforceStrictCapabilities) {
            this._legacy._assertCapabilityForMethod(request.method);
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
                    const ctx: ClientContext = {
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
                    };
                    const res = await this._legacy._dispatch(
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
     * untouched so {@linkcode connect} falls through to the legacy
     * `initialize` handshake.
     */
    private async _negotiate(transport: Transport, options?: RequestOptions): Promise<void> {
        const sar = transport.sendAndReceive?.bind(transport);
        const preferred = this.config.supportedProtocolVersions.find(v => isStatelessProtocolVersion(v));
        if (!sar || !preferred) return;

        transport.setProtocolVersion?.(preferred);
        const timeoutSignal = AbortSignal.timeout(options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC);
        const signal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
        try {
            const raw = await this._collect(sar({ method: 'server/discover', params: { _meta: this._buildMeta(preferred) } }, { signal }), {
                signal
            });
            const drParsed = DiscoverResultSchema.safeParse(raw);
            if (drParsed.success) {
                const dr = drParsed.data;
                // The probe only counts as success when there is a mutual
                // *stateless* version; otherwise fall through to legacy initialize.
                const negotiated = dr.supportedVersions.find(
                    v => isStatelessProtocolVersion(v) && this.config.supportedProtocolVersions.includes(v)
                );
                if (negotiated) {
                    this._legacy._setNegotiated({
                        serverCapabilities: dr.capabilities,
                        serverVersion: dr.serverInfo,
                        instructions: dr.instructions,
                        protocolVersion: negotiated
                    });
                    this._isStateless = true;
                    transport.setProtocolVersion?.(negotiated);
                    return;
                }
            }
        } catch (error) {
            if (!isFallbackable(error)) {
                // Reset the version we set before re-throwing so the
                // transport is not left advertising a stateless version.
                transport.setProtocolVersion?.(this._legacy.getNegotiatedProtocolVersion() ?? '');
                throw error;
            }
        }
        // Fallback path: reset the version header so the subsequent legacy
        // `_initialize()` (run by `connect()`) can set it.
        transport.setProtocolVersion?.(this._legacy.getNegotiatedProtocolVersion() ?? '');
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
    // ═══════════════════════════════════════════════════════════════════════

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
    async connect(transport: Transport, options?: RequestOptions): Promise<void> {
        await this._legacy.connect(transport);
        // When transport sessionId is already set this means we are trying to reconnect.
        // Restore the protocol version negotiated during the original initialize handshake
        // so HTTP transports include the required mcp-protocol-version header, but skip re-init.
        if (transport.sessionId !== undefined) {
            const negotiated = this._legacy.getNegotiatedProtocolVersion();
            if (negotiated !== undefined && transport.setProtocolVersion) {
                transport.setProtocolVersion(negotiated);
            }
            return;
        }
        try {
            // Probe `server/discover` (SEP-2575). If it succeeds, this client is
            // stateless and the legacy `initialize` is skipped.
            await this._negotiate(transport, options);
            if (!this._isStateless) {
                await this._legacy._initialize(transport, options);
            }
            this._setupListChanged();
        } catch (error) {
            // Disconnect if initialization fails.
            void this.close();
            throw error;
        }
    }

    async close(): Promise<void> {
        this._isStateless = false;
        this._listChangedAbort?.abort();
        this._listChangedAbort = undefined;
        await this._legacy.close();
    }

    get transport(): Transport | undefined {
        return this._legacy.transport;
    }

    get onclose(): (() => void) | undefined {
        return this._legacy.onclose;
    }
    set onclose(cb: (() => void) | undefined) {
        this._legacy.onclose = cb;
    }

    get onerror(): ((error: Error) => void) | undefined {
        return this._legacy.onerror;
    }
    set onerror(cb: ((error: Error) => void) | undefined) {
        this._legacy.onerror = cb;
    }

    get fallbackNotificationHandler(): ((notification: Notification) => Promise<void>) | undefined {
        return this._legacy.fallbackNotificationHandler;
    }
    set fallbackNotificationHandler(cb: ((notification: Notification) => Promise<void>) | undefined) {
        this._legacy.fallbackNotificationHandler = cb;
    }

    /**
     * Set up handlers for list changed notifications based on config and server capabilities.
     * This should only be called after initialization when server capabilities are known.
     * Handlers are silently skipped if the server doesn't advertise the corresponding listChanged capability.
     * @internal
     */
    private _setupListChangedHandlers(config: ListChangedHandlers): void {
        const caps = this._legacy.getServerCapabilities();
        if (config.tools && caps?.tools?.listChanged) {
            this._legacy._setupListChangedHandler('tools', 'notifications/tools/list_changed', config.tools, async () => {
                const result = await this.listTools();
                return result.tools;
            });
        }

        if (config.prompts && caps?.prompts?.listChanged) {
            this._legacy._setupListChangedHandler('prompts', 'notifications/prompts/list_changed', config.prompts, async () => {
                const result = await this.listPrompts();
                return result.prompts;
            });
        }

        if (config.resources && caps?.resources?.listChanged) {
            this._legacy._setupListChangedHandler('resources', 'notifications/resources/list_changed', config.resources, async () => {
                const result = await this.listResources();
                return result.resources;
            });
        }
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
        const caps = this._legacy.getServerCapabilities();
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
        if (config.tools && caps?.tools?.listChanged) {
            add('notifications/tools/list_changed', 'toolsListChanged', config.tools, () => this.listTools().then(r => r.tools));
        }
        if (config.prompts && caps?.prompts?.listChanged) {
            add('notifications/prompts/list_changed', 'promptsListChanged', config.prompts, () => this.listPrompts().then(r => r.prompts));
        }
        if (config.resources && caps?.resources?.listChanged) {
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
     * Sets the minimum severity level for log messages sent by the server.
     * Stored locally for per-request `_meta.logLevel`; when not stateless,
     * also sends the legacy `logging/setLevel` RPC.
     */
    async setLoggingLevel(level: LoggingLevel, options?: RequestOptions) {
        this._logLevel = level;
        if (this._isStateless) return {};
        return this._legacy.request({ method: 'logging/setLevel', params: { level } }, EmptyResultSchema, options);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // delegating (single registry; legacy owns the Dispatcher + negotiated state)
    // ═══════════════════════════════════════════════════════════════════════

    setRequestHandler<M extends RequestMethod>(
        method: M,
        handler: (request: RequestTypeMap[M], ctx: ClientContext) => ResultTypeMap[M] | Promise<ResultTypeMap[M]>
    ): void;
    setRequestHandler<P extends StandardSchemaV1, R extends StandardSchemaV1 | undefined = undefined>(
        method: string,
        schemas: { params: P; result?: R },
        handler: (params: StandardSchemaV1.InferOutput<P>, ctx: ClientContext) => InferHandlerResult<R> | Promise<InferHandlerResult<R>>
    ): void;
    setRequestHandler(method: string, b: unknown, c?: unknown): void {
        (this._legacy.setRequestHandler as (m: string, b: unknown, c?: unknown) => void)(method, b, c);
    }

    removeRequestHandler(method: RequestMethod | string): void {
        this._legacy.removeRequestHandler(method);
    }

    assertCanSetRequestHandler(method: RequestMethod | string): void {
        this._legacy.assertCanSetRequestHandler(method);
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
    setNotificationHandler(method: string, b: unknown, c?: unknown): void {
        (this._legacy.setNotificationHandler as (m: string, b: unknown, c?: unknown) => void)(method, b, c);
    }

    get fallbackRequestHandler(): Handler<ClientContext> | undefined {
        return this._legacy.fallbackRequestHandler;
    }
    set fallbackRequestHandler(handler: Handler<ClientContext> | undefined) {
        this._legacy.fallbackRequestHandler = handler;
    }

    /**
     * Registers new capabilities. This can only be called before connecting to a transport.
     *
     * The new capabilities will be merged with any existing capabilities previously given (e.g., at initialization).
     */
    registerCapabilities(capabilities: ClientCapabilities): void {
        this._legacy.registerCapabilities(capabilities);
    }

    /**
     * After initialization has completed, this will be populated with the server's reported capabilities.
     */
    getServerCapabilities(): ServerCapabilities | undefined {
        return this._legacy.getServerCapabilities();
    }

    /**
     * After initialization has completed, this will be populated with information about the server's name and version.
     */
    getServerVersion(): Implementation | undefined {
        return this._legacy.getServerVersion();
    }

    /**
     * After initialization has completed, this will be populated with the protocol version negotiated
     * during the initialize handshake. When manually reconstructing a transport for reconnection, pass this
     * value to the new transport so it continues sending the required `mcp-protocol-version` header.
     */
    getNegotiatedProtocolVersion(): string | undefined {
        return this._legacy.getNegotiatedProtocolVersion();
    }

    /**
     * After initialization has completed, this may be populated with information about the server's instructions.
     */
    getInstructions(): string | undefined {
        return this._legacy.getInstructions();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // typed request methods (route via _send → falls back to legacy.request())
    // ═══════════════════════════════════════════════════════════════════════

    /** Requests argument autocompletion suggestions from the server for a prompt or resource. */
    async complete(params: CompleteRequest['params'], options?: RequestOptions) {
        return this._send({ method: 'completion/complete', params }, CompleteResultSchema, options);
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
        if (!this._legacy.getServerCapabilities()?.prompts && !this._enforceStrictCapabilities) {
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
        if (!this._legacy.getServerCapabilities()?.resources && !this._enforceStrictCapabilities) {
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
        if (!this._legacy.getServerCapabilities()?.resources && !this._enforceStrictCapabilities) {
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
        if (!this._legacy.getServerCapabilities()?.tools && !this._enforceStrictCapabilities) {
            // Respect capability negotiation: server does not support tools
            console.debug('Client.listTools() called but server does not advertise tools capability - returning empty list');
            return { tools: [] };
        }
        const result = await this._send({ method: 'tools/list', params }, ListToolsResultSchema, options);

        // Cache the tools and their output schemas for future validation
        this.cacheToolMetadata(result.tools);

        return result;
    }
}
