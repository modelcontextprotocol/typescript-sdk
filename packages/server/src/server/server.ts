import type {
    ClientMeta,
    CreateMessageRequest,
    CreateMessageResult,
    CreateMessageResultWithTools,
    DiscoverResult,
    DispatchContext,
    ElicitResult,
    Handler,
    Implementation,
    InferHandlerResult,
    InputRequest,
    JSONRPCErrorResponse,
    JSONRPCRequest,
    JSONRPCResponse,
    ListRootsResult,
    Notification,
    RequestMethod,
    RequestTypeMap,
    ResourceUpdatedNotification,
    ResultTypeMap,
    ServerCapabilities,
    ServerContext,
    StandardSchemaV1,
    StatelessHandlers,
    Transport
} from '@modelcontextprotocol/core';
import {
    CreateMessageResultSchema,
    CreateMessageResultWithToolsSchema,
    ElicitResultSchema,
    errorResponse,
    InputRequiredError,
    JSONRPC_VERSION,
    ListRootsResultSchema,
    META_KEYS,
    parseClientMeta,
    ProtocolError,
    ProtocolErrorCode,
    SdkError,
    SdkErrorCode,
    STATELESS_REMOVED_METHODS,
    SubscriptionsListenRequestSchema,
    SUPPORTED_PROTOCOL_VERSIONS
} from '@modelcontextprotocol/core';

import type { ServerOptions } from './legacyServer.js';
import {
    assertElicitCapability,
    assertSamplingCapability,
    assertSamplingMessagePairing,
    LegacyServer,
    severityAtLeast,
    validateElicitFormContent
} from './legacyServer.js';
import type { SubscriptionBackend } from './subscriptions.js';
import { InMemorySubscriptions } from './subscriptions.js';

export type { ServerOptions } from './legacyServer.js';

/**
 * An MCP server on top of a pluggable transport.
 *
 * `Server` does not extend `Protocol`. It owns the 2026-06 stateless dispatch
 * path ({@linkcode statelessHandlers}, {@linkcode subscriptions}) and composes
 * a {@linkcode LegacyServer} (reachable via {@linkcode legacy}) for the
 * pre-2026 connection model. Both share one handler registry, so a single
 * `setRequestHandler` call serves clients of either protocol era.
 *
 * @deprecated Use {@linkcode server/mcp.McpServer | McpServer} instead for the high-level API. Only use `Server` for advanced use cases.
 */
export class Server {
    /**
     * Static identity + capabilities. Read by `_ondiscover`/`_dispatchStateless`;
     * `capabilities` is a getter delegating to {@linkcode legacy} so
     * `registerCapabilities` (on either `Server` or `LegacyServer`) stays
     * single-source.
     */
    readonly config: {
        readonly serverInfo: Implementation;
        readonly capabilities: ServerCapabilities;
        readonly instructions?: string;
        readonly supportedProtocolVersions: readonly string[];
    };

    /** Composed pre-2026 implementation; owns the `Protocol` connection. */
    private readonly _legacy: LegacyServer;

    /**
     * Initializes this server with the given name and version information.
     */
    constructor(serverInfo: Implementation, options?: ServerOptions) {
        this._legacy = new LegacyServer(serverInfo, options);
        const legacy = this._legacy;
        this.config = {
            serverInfo,
            get capabilities(): ServerCapabilities {
                return legacy.getCapabilities();
            },
            ...(options?.instructions === undefined ? {} : { instructions: options.instructions }),
            supportedProtocolVersions: options?.supportedProtocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS
        };
        this.subscriptions = options?.subscriptions ?? new InMemorySubscriptions();

        this._legacy.setRequestHandler('server/discover', async (): Promise<DiscoverResult> => this._ondiscover());
    }

    /**
     * Escape hatch to the composed pre-2026 connection-model server (extends
     * `Protocol`). Use for `createMessage`/`elicitInput`/`listRoots`/`ping`/
     * `sendLoggingMessage`/`oninitialized` against a connected pre-2026 client.
     */
    get legacy(): LegacyServer {
        return this._legacy;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 2026 stateless (SEP-2575/2322)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Backend for `subscriptions/listen`. Default in-memory; pass via
     * `ServerOptions.subscriptions` for distributed deployments.
     */
    readonly subscriptions: SubscriptionBackend;

    /**
     * Builds the {@linkcode StatelessHandlers} pair this server provides to
     * transports (via `setStatelessHandlers`) and to `handleHttp`.
     */
    statelessHandlers(): StatelessHandlers {
        return {
            dispatch: (req, ctx) => this._dispatchStateless(req, ctx),
            listen: (req, ctx) =>
                this.subscriptions.handle({ ...SubscriptionsListenRequestSchema.parse(req), id: req.id }, ctx, this.config.capabilities)
        };
    }

    /**
     * server/discover handler. Returns this server's identity, capabilities,
     * and supported protocol versions.
     */
    private _ondiscover(): DiscoverResult {
        return {
            supportedVersions: [...this.config.supportedProtocolVersions],
            capabilities: this.config.capabilities,
            serverInfo: this.config.serverInfo,
            ...(this.config.instructions === undefined ? {} : { instructions: this.config.instructions })
        };
    }

    /**
     * Dispatches one stateless JSON-RPC request and returns its response.
     *
     * Builds a per-request `ServerContext` from {@linkcode DispatchContext} +
     * the request's `_meta` (notify/log via `dctx.notify`; `send` throws;
     * `elicitInput`/`requestSampling` are MRTR throw-then-cache), then routes
     * through the shared {@linkcode Dispatcher} so the same registry and
     * middleware chain as `_onrequest` apply. Pre-2026-only methods are
     * rejected before the dispatcher.
     */
    private async _dispatchStateless(request: JSONRPCRequest, dctx: DispatchContext): Promise<JSONRPCResponse | JSONRPCErrorResponse> {
        const id = request.id;
        const meta = dctx.meta ?? parseClientMeta(request.params);

        if (meta.protocolVersion !== undefined && !this.config.supportedProtocolVersions.includes(meta.protocolVersion)) {
            return errorResponse(id, ProtocolErrorCode.InvalidParams, 'Unsupported protocol version', {
                supported: [...this.config.supportedProtocolVersions],
                requested: meta.protocolVersion
            });
        }

        if (STATELESS_REMOVED_METHODS.has(request.method)) {
            return errorResponse(id, ProtocolErrorCode.MethodNotFound, `Method not found: '${request.method}'`);
        }

        const ctx = this._buildDispatchServerContext(request, dctx, meta);

        const response = await this._legacy._dispatch(request, ctx);
        // Default resultType:'complete' on success, but never on server/discover
        // (DiscoverResult has no resultType field).
        if (
            request.method !== 'server/discover' &&
            'result' in response &&
            (response.result as { resultType?: unknown }).resultType === undefined
        ) {
            return { ...response, result: { ...response.result, resultType: 'complete' } };
        }
        return response;
    }

    /**
     * Builds the `ServerContext` handlers receive under the stateless dispatch
     * path. `notify`/`log` go out via `dctx.notify`; `send` throws (no push
     * channel under stateless); `elicitInput`/`requestSampling`/`listRoots`
     * are MRTR throw-then-cache against `params.inputResponses`.
     */
    private _buildDispatchServerContext(request: JSONRPCRequest, dctx: DispatchContext, per: ClientMeta): ServerContext {
        let mrtrSeq = 0;
        const mrtrOrThrow = <R>(method: string, params: unknown, schema: { parse(v: unknown): R }, after?: (r: R) => void): Promise<R> => {
            const key = `${method}#${mrtrSeq++}`;
            const cached = per.inputResponses?.[key];
            if (cached !== undefined) {
                // Validate the cached value: do not return raw client input.
                let parsed: R;
                try {
                    parsed = schema.parse(cached);
                } catch (error) {
                    throw new ProtocolError(
                        ProtocolErrorCode.InvalidParams,
                        `inputResponses['${key}'] does not match expected schema: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
                after?.(parsed);
                return Promise.resolve(parsed);
            }
            throw new InputRequiredError({ [key]: { method, params } as InputRequest });
        };

        const notify = (n: Notification): Promise<void> => {
            // Stamp `_meta.subscriptionId` (= the JSON-RPC request id, per
            // SEP-2575) so notifications correlate to this request on
            // pipe-shaped client transports that demultiplex a single inbound
            // stream. Handler-supplied `_meta` first, server-stamped key last,
            // so a handler cannot override the framing key.
            const _meta = { ...n.params?._meta, [META_KEYS.subscriptionId]: String(request.id) };
            const params = { ...n.params, _meta };
            dctx.notify({ jsonrpc: JSONRPC_VERSION, method: n.method, params });
            return Promise.resolve();
        };

        const sendThrows = (() => {
            throw new SdkError(
                SdkErrorCode.CapabilityNotSupported,
                'Server-to-client requests are not available under the stateless dispatch path; use ctx.mcpReq.elicitInput/requestSampling (MRTR).'
            );
        }) as ServerContext['mcpReq']['send'];

        return {
            sessionId: undefined,
            clientCapabilities: per.clientCapabilities,
            mcpReq: {
                id: request.id,
                method: request.method,
                _meta: request.params?._meta,
                signal: dctx.signal ?? new AbortController().signal,
                send: sendThrows,
                notify,
                log: async (level, data, logger) => {
                    // Spec: server MUST NOT emit notifications/message for
                    // requests that did not include _meta.logLevel.
                    if (per.logLevel === undefined || !severityAtLeast(level, per.logLevel)) return;
                    await notify({ method: 'notifications/message', params: { level, data, ...(logger === undefined ? {} : { logger }) } });
                },
                listRoots: params => mrtrOrThrow<ListRootsResult>('roots/list', params ?? {}, ListRootsResultSchema),
                elicitInput: params => {
                    // Sub-capability (form/url) check only when the top-level
                    // `elicitation` capability is declared. Absent top-level is
                    // handled by `inputRequiredMiddleware` (-32003) so the wire
                    // error code matches SEP-2322.
                    if (per.clientCapabilities?.elicitation) assertElicitCapability(params, per.clientCapabilities);
                    return mrtrOrThrow<ElicitResult>('elicitation/create', params, ElicitResultSchema, result =>
                        validateElicitFormContent(this._legacy._validator, params, result)
                    );
                },
                // Cast: arrow has the implementation signature (union return);
                // narrowing is provided by the overload set on the field type.
                requestSampling: ((params: CreateMessageRequest['params']) => {
                    if (per.clientCapabilities?.sampling) assertSamplingCapability(params, per.clientCapabilities);
                    assertSamplingMessagePairing(params);
                    return mrtrOrThrow<CreateMessageResult | CreateMessageResultWithTools>(
                        'sampling/createMessage',
                        params,
                        params.tools ? CreateMessageResultWithToolsSchema : CreateMessageResultSchema
                    );
                }) as ServerContext['mcpReq']['requestSampling']
            },
            http:
                dctx.authInfo !== undefined || dctx.httpRequest !== undefined
                    ? { authInfo: dctx.authInfo, req: dctx.httpRequest }
                    : undefined
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // dual-mode (SEP-2575/2567)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Connects this server to a transport. Installs the stateless
     * {@linkcode statelessHandlers | dispatch/listen} pair on transports that
     * support per-message routing (`setStatelessHandlers` is optional on the
     * `Transport` interface), then starts the legacy `Protocol` connect path
     * so pre-2026 clients also work over the same transport.
     */
    async connect(transport: Transport): Promise<void> {
        // Install stateless handlers before starting the transport so the
        // first message cannot arrive before the router is wired.
        transport.setStatelessHandlers?.(this.statelessHandlers());
        await this._legacy.connect(transport);
    }

    async close(): Promise<void> {
        return this._legacy.close();
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

    /**
     * Runs `subscriptions.notify` and the legacy `notification()` concurrently.
     * A subscription-backend rejection does not block legacy delivery (and is
     * surfaced via `onerror`); a legacy rejection (cap-missing, send fail) is
     * rethrown so existing callers see the same errors as before.
     */
    private async _fanoutNotify(event: Parameters<SubscriptionBackend['notify']>[0], legacy: () => Promise<void>): Promise<void> {
        const [sub, leg] = await Promise.allSettled([this.subscriptions.notify(event), this.transport ? legacy() : Promise.resolve()]);
        if (sub.status === 'rejected') {
            this.onerror?.(sub.reason instanceof Error ? sub.reason : new Error(String(sub.reason)));
        }
        if (leg.status === 'rejected') throw leg.reason;
    }

    async sendResourceUpdated(params: ResourceUpdatedNotification['params']) {
        await this._fanoutNotify({ type: 'resourceUpdated', uri: params.uri }, () =>
            this._legacy.notification({ method: 'notifications/resources/updated', params })
        );
    }

    async sendResourceListChanged() {
        await this._fanoutNotify({ type: 'resourcesListChanged' }, () =>
            this._legacy.notification({ method: 'notifications/resources/list_changed' })
        );
    }

    async sendToolListChanged() {
        await this._fanoutNotify({ type: 'toolsListChanged' }, () =>
            this._legacy.notification({ method: 'notifications/tools/list_changed' })
        );
    }

    async sendPromptListChanged() {
        await this._fanoutNotify({ type: 'promptsListChanged' }, () =>
            this._legacy.notification({ method: 'notifications/prompts/list_changed' })
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // delegating (single registry; legacy owns the Dispatcher)
    // ═══════════════════════════════════════════════════════════════════════

    setRequestHandler<M extends RequestMethod>(
        method: M,
        handler: (request: RequestTypeMap[M], ctx: ServerContext) => ResultTypeMap[M] | Promise<ResultTypeMap[M]>
    ): void;
    setRequestHandler<P extends StandardSchemaV1, R extends StandardSchemaV1 | undefined = undefined>(
        method: string,
        schemas: { params: P; result?: R },
        handler: (params: StandardSchemaV1.InferOutput<P>, ctx: ServerContext) => InferHandlerResult<R> | Promise<InferHandlerResult<R>>
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

    get fallbackRequestHandler(): Handler<ServerContext> | undefined {
        return this._legacy.fallbackRequestHandler;
    }
    set fallbackRequestHandler(handler: Handler<ServerContext> | undefined) {
        this._legacy.fallbackRequestHandler = handler;
    }

    /**
     * Registers new capabilities. This can only be called before connecting to a transport.
     *
     * The new capabilities will be merged with any existing capabilities previously given (e.g., at initialization).
     */
    registerCapabilities(capabilities: ServerCapabilities): void {
        this._legacy.registerCapabilities(capabilities);
    }

    /**
     * Returns the current server capabilities.
     */
    getCapabilities(): ServerCapabilities {
        return this.config.capabilities;
    }
}
