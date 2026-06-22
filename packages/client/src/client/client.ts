import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/client/_shims';
import type {
    BaseContext,
    CallToolRequest,
    CallToolResult,
    ClientCapabilities,
    ClientContext,
    ClientNotification,
    ClientRequest,
    CompleteRequest,
    CompleteResult,
    DiscoverResult,
    EmptyResult,
    GetPromptRequest,
    GetPromptResult,
    Implementation,
    InputRequiredOptions,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResponse,
    JsonSchemaType,
    JsonSchemaValidator,
    jsonSchemaValidator,
    ListChangedHandlers,
    ListChangedOptions,
    ListPromptsRequest,
    ListPromptsResult,
    ListResourcesRequest,
    ListResourcesResult,
    ListResourceTemplatesRequest,
    ListResourceTemplatesResult,
    ListToolsRequest,
    ListToolsResult,
    LoggingLevel,
    MessageExtraInfo,
    NonCompleteResultFlow,
    NotificationMethod,
    ProtocolEra,
    ProtocolOptions,
    ReadResourceRequest,
    ReadResourceResult,
    RequestMethod,
    RequestOptions,
    ResolvedInputRequiredDriverConfig,
    Result,
    ServerCapabilities,
    StandardSchemaV1,
    SubscribeRequest,
    SubscriptionFilter,
    Tool,
    Transport,
    UnsubscribeRequest,
    XMcpHeaderScanResult
} from '@modelcontextprotocol/core';
import {
    buildMcpParamHeaders,
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    codecForVersion,
    CreateMessageResultSchema,
    CreateMessageResultWithToolsSchema,
    DEFAULT_REQUEST_TIMEOUT_MSEC,
    DiscoverResultSchema,
    HEADER_MISMATCH_ERROR_CODE,
    isJSONRPCErrorResponse,
    isJSONRPCRequest,
    isModernProtocolVersion,
    legacyProtocolVersions,
    ListChangedOptionsBaseSchema,
    mergeCapabilities,
    parseSchema,
    Protocol,
    PROTOCOL_VERSION_META_KEY,
    ProtocolError,
    ProtocolErrorCode,
    resolveInputRequiredDriverConfig,
    runInputRequiredFlow,
    scanXMcpHeaderDeclarations,
    SdkError,
    SdkErrorCode,
    SUBSCRIPTION_ID_META_KEY,
    SubscriptionFilterSchema
} from '@modelcontextprotocol/core';

import type { ResponseCacheStore } from './responseCache.js';
import { ClientResponseCache, InMemoryResponseCacheStore } from './responseCache.js';
import type { ResolvedVersionNegotiation, VersionNegotiationOptions } from './versionNegotiation.js';
import { detectProbeEnvironment, detectProbeTransportKind, negotiateEra, resolveVersionNegotiation } from './versionNegotiation.js';

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
     * @default Runtime-selected validator (AJV-backed on Node.js, `@cfworker/json-schema`-backed on browser/workerd runtimes)
     */
    jsonSchemaValidator?: jsonSchemaValidator;

    /**
     * Opt-in protocol version negotiation (protocol revision 2026-07-28 and later).
     *
     * **The default is `'legacy'`**: absent (or `mode: 'legacy'`), `connect()`
     * runs the plain 2025 sequence, byte-identical to today's behavior (no
     * probe, no new headers). Opt into `'auto'` or pin to talk to a 2026-07-28
     * server.
     *
     * - `mode: 'auto'` — `connect()` probes the server with `server/discover` first:
     *   definitive modern evidence selects the modern era; definitive legacy signals
     *   (and anything unrecognized) fall back to the plain legacy `initialize`
     *   handshake on the same connection, byte-equivalent to a 2025 client. A
     *   network outage rejects with a typed connect error. A probe timeout is
     *   transport-aware: on stdio it indicates a legacy server (some legacy servers
     *   never answer unknown pre-`initialize` requests) and falls back to
     *   `initialize` on the same stream; on HTTP it rejects with a typed timeout
     *   error (silence on a deployed server is an outage, not a legacy signal).
     * - `mode: { pin: '2026-07-28' }` — modern era at exactly the pinned revision;
     *   no probe-and-fallback: anything else fails loudly.
     *
     * Probe policy lives under `probe: { timeoutMs?, maxRetries? }`; the probe
     * inherits the client's standard request timeout unless overridden, and
     * `maxRetries` (default `0`) governs timeout re-sends only — the
     * spec-mandated `-32004` corrective continuation is never counted against it.
     *
     * Once a modern era is negotiated, the client automatically attaches the
     * per-request `_meta` envelope (the reserved protocol-version / client-info /
     * client-capabilities keys) to every outgoing request and notification;
     * user-supplied `_meta` keys take precedence over the auto-attached ones.
     */
    versionNegotiation?: VersionNegotiationOptions;

    /**
     * Multi-round-trip auto-fulfilment (protocol revision 2026-07-28).
     *
     * On the 2026-07-28 era, servers obtain client input (elicitation,
     * sampling, roots) by answering `tools/call`, `prompts/get`, or
     * `resources/read` with an `input_required` result instead of sending a
     * server→client request. By default the client fulfils those embedded
     * requests automatically through the SAME handlers registered via
     * {@linkcode Client.setRequestHandler | setRequestHandler} (e.g.
     * `elicitation/create`), then retries the original call with the
     * collected `inputResponses` and a byte-exact echo of the opaque
     * `requestState`, on a fresh request id, up to `maxRounds` rounds.
     * `client.callTool()` (and its siblings) keep returning their plain
     * result type — the interactive rounds happen inside the call.
     *
     * Set `autoFulfill: false` for manual mode: an `input_required` response
     * then surfaces as a typed error unless the individual call passes
     * `allowInputRequired: true` (pair it with `withInputRequired()` on the
     * explicit-schema path to type both outcomes).
     *
     * Has no effect on 2025-era connections, which have no `input_required`
     * vocabulary.
     */
    inputRequired?: InputRequiredOptions;

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

    /**
     * Cap on the number of pages the auto-aggregating
     * {@linkcode Client.listTools | listTools()} /
     * {@linkcode Client.listPrompts | listPrompts()} /
     * {@linkcode Client.listResources | listResources()} /
     * {@linkcode Client.listResourceTemplates | listResourceTemplates()} walk
     * fetches before throwing (a defence against a server whose `nextCursor`
     * never converges). `0` disables the cap. Default: `64`. Applies only to
     * the no-argument auto-aggregate path; an explicit-`cursor` per-page call
     * is never capped.
     */
    listMaxPages?: number;

    /**
     * The response-cache store backing the client's derived views (the cached
     * `tools/list` result that {@linkcode Client.callTool | callTool}'s output
     * validation and SEP-2243 header mirroring will read once the stacked
     * SEP-2243 PR lands; this commit ships only the seam). Defaults to a fresh
     * {@linkcode InMemoryResponseCacheStore} per client.
     *
     * **Do not share one store across clients at all in v2.0.x** — entries
     * are keyed by method + params only, so two clients connected to
     * different servers (even under the same credential) collide on
     * `tools/list`, and one client's `list_changed` evicts every co-tenant's
     * entry. Supply your own only as a single-client backing store.
     * Per-principal partitioning that enables safe sharing is #39.
     */
    responseCacheStore?: ResponseCacheStore;
};

/**
 * Options for {@linkcode Client.callTool}. Extends {@linkcode RequestOptions}
 * with an escape hatch for callers that already hold the tool definition
 * (e.g. from a previous session or configuration) — pass it via
 * `toolDefinition` so SEP-2243 `Mcp-Param-*` header mirroring can run without a
 * prior `tools/list`.
 */
export type CallToolRequestOptions = RequestOptions & {
    /**
     * The tool definition to use for SEP-2243 `Mcp-Param-*` header mirroring on
     * a 2026-07-28 connection over Streamable HTTP, AND for output-schema
     * validation of the result. When set, the client uses this definition's
     * `inputSchema` and `outputSchema` instead of (and without consulting) the
     * cached `tools/list` result, so the two derived views agree.
     */
    toolDefinition?: Tool;
};

/**
 * `list_changed` notification → response-cache method(s) to evict. `resources`
 * covers both list verbs (the spec's "relevant notification ⇒ immediately
 * stale").
 */
const LIST_CHANGED_EVICTIONS: Readonly<Record<string, readonly string[]>> = {
    'notifications/tools/list_changed': ['tools/list'],
    'notifications/prompts/list_changed': ['prompts/list'],
    'notifications/resources/list_changed': ['resources/list', 'resources/templates/list']
};

const DEFAULT_LIST_MAX_PAGES = 64;

/**
 * A handle to an open `subscriptions/listen` stream (protocol revision
 * 2026-07-28). Change notifications delivered on the stream dispatch to the
 * existing {@linkcode Client.setNotificationHandler} registrations.
 */
export interface McpSubscription {
    /**
     * The subset of the requested filter the server agreed to honor (from
     * `notifications/subscriptions/acknowledged`).
     */
    readonly honoredFilter: SubscriptionFilter;
    /**
     * Tears the subscription down. Idempotent. Aborts the listen request's
     * stream (where the transport supports it) AND sends
     * `notifications/cancelled` referencing the listen request id — both,
     * always, so close works on any transport.
     */
    close(): Promise<void>;
    /**
     * Resolves exactly once when the subscription has terminated. Never
     * rejects — this is an observation, not an operation.
     *
     * - `'local'` — you called {@linkcode close} (or aborted the
     *   `RequestOptions.signal` you passed to `listen()`).
     * - `'remote'` — the server cancelled, the stream ended, or the transport
     *   dropped. Re-listen if you still want events.
     */
    readonly closed: Promise<'local' | 'remote'>;
}

/** @internal */
interface ListenStateEntry {
    /**
     * The single funnel for the per-listen `opening → open → closed` state
     * machine. Every transport-level feed source — the `_onnotification` /
     * `_onresponse` / `_onclose` overrides, `onRequestStreamEnd`, send
     * failure, ack timeout, caller-signal abort, `_resetConnectionState` —
     * routes through it.
     */
    settle: (outcome: { ack: SubscriptionFilter } | { cause: 'local' | 'remote'; error?: Error }) => void;
}

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
 * Note: the `roots/list` and `sampling/createMessage` handler surfaces (and the corresponding
 * `roots` and `sampling` capabilities) are deprecated as of protocol version 2026-07-28
 * (SEP-2577). They remain functional during the deprecation window (at least twelve months).
 * Migrate sampling to calling LLM provider APIs directly, and roots to passing paths via tool
 * parameters, resource URIs, or configuration.
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
    private _capabilities: ClientCapabilities;
    private _instructions?: string;
    private _jsonSchemaValidator: jsonSchemaValidator;
    /**
     * The response-cache substrate. Owns the backing store, the per-method
     * eviction-generation counter, the user-supplied/default flag, and the
     * stamp-memoized derived `name → Tool` / `name → output-validator`
     * indices — the cache-coordination state that used to live as separate
     * private fields here. The internal aggregating walk writes one entry per
     * list verb; `list_changed` evicts the matching method;
     * `_resetConnectionState` resets the lot. {@linkcode callTool}'s
     * output-schema validation reads the derived `outputValidator` index (the
     * substrate's first production caller); the stacked SEP-2243 PR wires
     * `Mcp-Param-*` mirroring through `toolDefinition` on top.
     */
    private readonly _cache: ClientResponseCache;
    private readonly _listMaxPages: number;
    private _listChangedDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    /**
     * The constructor `listChanged` configuration. Durable across reconnects:
     * read fresh on every connect (legacy or modern), never consumed.
     */
    private readonly _listChangedConfig?: ListChangedHandlers;
    private _enforceStrictCapabilities: boolean;
    private _versionNegotiation?: VersionNegotiationOptions;
    private _supportedProtocolVersionsOption?: string[];
    private _inputRequiredDriverConfig: ResolvedInputRequiredDriverConfig;
    /**
     * Active subscriptions/listen state, keyed by subscription id (= the
     * listen request's JSON-RPC id verbatim). The id is a STRING from a
     * Client-owned counter (`'listen:' + N`) — JSON-RPC permits string ids,
     * and Protocol's numeric `_requestMessageId` counter only ever issues
     * numbers, so listen ids cannot collide with ordinary request ids.
     */
    private _listenState = new Map<string, ListenStateEntry>();
    private _nextListenId = 0;
    /** The auto-opened subscription backing ClientOptions.listChanged on a modern connection. */
    private _autoOpenedSubscription?: McpSubscription;

    /**
     * Clears every per-connection field in one place. Called at the start of
     * each fresh (non-resuming) connect and from `close()`, so a stale
     * negotiated era / server identity / auto-opened subscription cannot
     * survive a reconnect.
     */
    private _resetConnectionState(): void {
        this._negotiatedProtocolVersion = undefined;
        this._serverCapabilities = undefined;
        this._serverVersion = undefined;
        this._instructions = undefined;
        this._autoOpenedSubscription = undefined;
        // Settle every live per-listen state machine before clearing the map:
        // a fresh connect (or close) on a connection whose prior transport
        // never fired onclose would otherwise leave an in-flight listen()
        // promise hanging forever. Each entry's settle() deletes only itself
        // (Map self-delete during iteration is well-defined).
        if (this._listenState.size > 0) {
            const reason = new SdkError(
                SdkErrorCode.ConnectionClosed,
                'subscriptions/listen: client reconnected or closed; subscription state from the previous connection was reset'
            );
            for (const entry of this._listenState.values()) {
                entry.settle({ cause: 'remote', error: reason });
            }
        }
        this._listenState.clear();
        // Debounce timers are connection-scoped: a callback armed on a
        // connection that is now gone must not fire onto whatever connection
        // (if any) replaces it.
        for (const timer of this._listChangedDebounceTimers.values()) {
            clearTimeout(timer);
        }
        this._listChangedDebounceTimers.clear();
        // A user-supplied store is NOT cleared on reconnect/close — that would
        // defeat the only reason to supply one. The per-instance default IS
        // cleared (it is connection-scoped); derived indices and the
        // generation map are dropped regardless. The default impl is
        // synchronous, so the call returns plain void here.
        this._cache.resetForReconnect();
    }

    override async close(): Promise<void> {
        try {
            await super.close();
        } finally {
            // Per-connection state is cleared even when the transport's close
            // rejects, so a stale negotiated era / live listen state cannot
            // survive a failed close.
            this._resetConnectionState();
        }
    }

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
        this._versionNegotiation = options?.versionNegotiation;
        this._supportedProtocolVersionsOption = options?.supportedProtocolVersions;
        // Multi-round-trip auto-fulfilment driver (2026-07-28): on by default,
        // configurable via ClientOptions.inputRequired.
        this._inputRequiredDriverConfig = resolveInputRequiredDriverConfig(options?.inputRequired);
        // Response-cache substrate. A fresh in-memory store is allocated when
        // the caller does not supply one — never share a default across
        // instances (see ClientOptions.responseCacheStore).
        this._cache = new ClientResponseCache(
            options?.responseCacheStore ?? new InMemoryResponseCacheStore(),
            options?.responseCacheStore !== undefined,
            error => this._reportStoreError(error)
        );
        this._listMaxPages = options?.listMaxPages ?? DEFAULT_LIST_MAX_PAGES;

        // Store list changed config for setup after connection (when we know server capabilities)
        if (options?.listChanged) {
            this._listChangedConfig = options.listChanged;
        }
    }

    protected override buildContext(ctx: BaseContext, _transportInfo?: MessageExtraInfo): ClientContext {
        return ctx;
    }

    /**
     * Era-keyed direction enforcement for inbound traffic on channels whose
     * transport does not classify (e.g. stdio): the 2026-07-28 era has no
     * server→client JSON-RPC request channel — server-to-client interactions
     * are carried in-band in `input_required` results — and on stdio the
     * client must never write JSON-RPC responses. An inbound request arriving
     * on a connection that negotiated a modern era is therefore dropped
     * (surfaced via `onerror`) rather than answered. Connections on a legacy
     * era — and all responses and notifications — keep today's dispatch path.
     */
    protected override _shouldDropInbound(message: JSONRPCRequest | JSONRPCNotification): 'drop' | undefined {
        if (
            this._negotiatedProtocolVersion !== undefined &&
            isModernProtocolVersion(this._negotiatedProtocolVersion) &&
            isJSONRPCRequest(message)
        ) {
            return 'drop';
        }
        return undefined;
    }

    /**
     * Per-request `_meta` envelope auto-emission (protocol revision 2026-07-28):
     * on a connection that negotiated a modern era — auto-negotiated or pinned —
     * every outgoing request and notification automatically carries the reserved
     * protocol-version / client-info / client-capabilities `_meta` keys (the
     * same envelope the connect-time `server/discover` probe sends).
     * User-supplied `_meta` keys take precedence over the auto-attached ones.
     *
     * Legacy-era connections return `undefined`: the envelope seam is a no-op
     * and outbound traffic is byte-identical to a 2025 client (the legacy
     * `'auto'` fallback included).
     */
    protected override _outboundMetaEnvelope(): Readonly<Record<string, unknown>> | undefined {
        const version = this._negotiatedProtocolVersion;
        if (version === undefined || !isModernProtocolVersion(version)) {
            return undefined;
        }
        return {
            [PROTOCOL_VERSION_META_KEY]: version,
            [CLIENT_INFO_META_KEY]: this._clientInfo,
            [CLIENT_CAPABILITIES_META_KEY]: this._capabilities
        };
    }

    /**
     * Wires the multi-round-trip auto-fulfilment engine (protocol revision
     * 2026-07-28) into the response funnel: an `input_required` answer is
     * fulfilled through the registered elicitation/sampling/roots handlers
     * and the original request retried via `flow.retry`, up to
     * `inputRequired.maxRounds` rounds. With auto-fulfilment disabled the
     * response surfaces as a typed error steering to manual mode.
     */
    protected override _resolveNonCompleteResult<T extends StandardSchemaV1>(
        decoded: { kind: 'input_required'; inputRequests: Record<string, unknown>; requestState?: string },
        flow: NonCompleteResultFlow<T>
    ): Promise<unknown> {
        if (!this._inputRequiredDriverConfig.autoFulfill) {
            return Promise.reject(
                new SdkError(
                    SdkErrorCode.UnsupportedResultType,
                    `Unsupported result type 'input_required' for ${flow.request.method}: ` +
                        `multi-round-trip auto-fulfilment is not enabled on this instance — ` +
                        `pass allowInputRequired: true to handle it manually, or enable inputRequired.autoFulfill`,
                    { resultType: 'input_required', method: flow.request.method }
                )
            );
        }
        return runInputRequiredFlow(
            {
                getRequestHandler: method =>
                    this._getRequestHandler(method) as ((request: JSONRPCRequest, ctx: unknown) => Promise<Result>) | undefined,
                buildContext: baseCtx => this.buildContext(baseCtx, undefined),
                sessionId: this.transport?.sessionId
            },
            this._inputRequiredDriverConfig,
            decoded,
            flow
        );
    }

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
     * Configure protocol version negotiation before connecting (equivalent to
     * passing `versionNegotiation` at construction time). Can only be called
     * before connecting to a transport. Passing `undefined` clears a previously
     * configured negotiation, restoring the default `'legacy'` posture.
     *
     * See {@linkcode ClientOptions | ClientOptions.versionNegotiation} for the mode semantics.
     */
    public setVersionNegotiation(options: VersionNegotiationOptions | undefined): void {
        if (this.transport) {
            throw new Error('Cannot configure version negotiation after connecting to transport');
        }
        this._versionNegotiation = options;
    }

    /**
     * Enforces client-side validation for `elicitation/create` and `sampling/createMessage`
     * regardless of how the handler was registered.
     */
    protected override _wrapHandler(
        method: string,
        handler: (request: JSONRPCRequest, ctx: ClientContext) => Promise<Result>
    ): (request: JSONRPCRequest, ctx: ClientContext) => Promise<Result> {
        if (method === 'elicitation/create') {
            return async (request, ctx) => {
                // Era-exact validation: the schemas are resolved from the
                // instance era at dispatch time. On the 2025 era the method
                // is a wire request (registry schemas); on the 2026 era it is
                // in-band vocabulary reached only via the multi-round-trip
                // driver, so the in-band schemas apply.
                const codec = codecForVersion(this._negotiatedProtocolVersion);
                const elicitRequestSchema = codec.requestSchema('elicitation/create') ?? codec.inputRequestSchema('elicitation/create');
                // The era registry entry IS the plain ElicitResult schema
                // (the result map is aligned to the typed map — no widened
                // unions), so no narrower surface is needed.
                const elicitResultSchema = codec.resultSchema('elicitation/create') ?? codec.inputResponseSchema('elicitation/create');
                if (!elicitRequestSchema || !elicitResultSchema) {
                    throw new ProtocolError(ProtocolErrorCode.InternalError, 'No wire schema for elicitation/create in the resolved era');
                }
                const validatedRequest = parseSchema(elicitRequestSchema, request);
                if (!validatedRequest.success) {
                    // Type guard: if success is false, error is guaranteed to exist
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

                const result = await handler(request, ctx);

                const validationResult = parseSchema(elicitResultSchema, result);
                if (!validationResult.success) {
                    // Type guard: if success is false, error is guaranteed to exist
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
            };
        }

        if (method === 'sampling/createMessage') {
            return async (request, ctx) => {
                // Era-exact validation via the instance era (see above): wire
                // request schema on the 2025 era, in-band schema on the 2026
                // era (where sampling reaches the handler only as an embedded
                // input request).
                const codec = codecForVersion(this._negotiatedProtocolVersion);
                const wireSamplingRequestSchema = codec.requestSchema('sampling/createMessage');
                const samplingRequestSchema = wireSamplingRequestSchema ?? codec.inputRequestSchema('sampling/createMessage');
                if (!samplingRequestSchema) {
                    throw new ProtocolError(
                        ProtocolErrorCode.InternalError,
                        'No wire schema for sampling/createMessage in the resolved era'
                    );
                }
                const validatedRequest = parseSchema(samplingRequestSchema, request);
                if (!validatedRequest.success) {
                    const errorMessage =
                        validatedRequest.error instanceof Error ? validatedRequest.error.message : String(validatedRequest.error);
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid sampling request: ${errorMessage}`);
                }

                const { params } = validatedRequest.data;

                const result = await handler(request, ctx);

                // The result-side schema mirrors the request-side selection so
                // both stay on the same era's vocabulary. On the 2025 era the
                // schema depends on the REQUEST params (tools vs no tools) —
                // something a method-keyed registry entry cannot express, so
                // the pair is picked here. When the request schema came from
                // the in-band fallback (2026 era, where sampling reaches the
                // handler only as an embedded input request), the embedded
                // response schema applies — it covers plain and tool-bearing
                // responses alike.
                const hasTools = params.tools || params.toolChoice;
                const resultSchema =
                    wireSamplingRequestSchema === undefined
                        ? codec.inputResponseSchema('sampling/createMessage')
                        : hasTools
                          ? CreateMessageResultWithToolsSchema
                          : CreateMessageResultSchema;
                if (!resultSchema) {
                    throw new ProtocolError(
                        ProtocolErrorCode.InternalError,
                        'No result schema for sampling/createMessage in the resolved era'
                    );
                }
                const validationResult = parseSchema(resultSchema, result);
                if (!validationResult.success) {
                    const errorMessage =
                        validationResult.error instanceof Error ? validationResult.error.message : String(validationResult.error);
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid sampling result: ${errorMessage}`);
                }

                return validationResult.data;
            };
        }

        return handler;
    }

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
        const negotiation = resolveVersionNegotiation(this._versionNegotiation, this._supportedProtocolVersionsOption);
        if (negotiation.kind !== 'legacy') {
            return this._connectNegotiated(transport, negotiation, options);
        }
        // Plain legacy connect — the pinned 2025 sequence, byte-untouched.
        await super.connect(transport);
        // When transport sessionId is already set this means we are trying to reconnect.
        // Restore the protocol version negotiated during the original initialize handshake
        // so HTTP transports include the required mcp-protocol-version header, but skip re-init.
        if (transport.sessionId !== undefined) {
            const negotiatedProtocolVersion = this._negotiatedProtocolVersion;
            if (negotiatedProtocolVersion !== undefined) {
                // Resuming keeps the original negotiation: the instance still
                // holds the negotiated version (and with it the wire era) —
                // only the new transport needs the header pushed again.
                transport.setProtocolVersion?.(negotiatedProtocolVersion);
            }
            return;
        }
        // Fresh connect: per-connection state left over from a previous
        // connection must not survive into a new handshake. Clearing it puts
        // the instance back in the pre-negotiation phase, so the initialize
        // exchange below rides the bootstrap method pins (legacy era) instead
        // of a dead session's era. Without this, an instance that once
        // negotiated a modern era could never re-run a fresh handshake:
        // `initialize` is physically absent from the modern registry. (The
        // resume branch above keeps it instead.)
        this._resetConnectionState();
        await this._legacyHandshake(transport, options);
    }

    /**
     * The 2025 `initialize` handshake — the body of the plain legacy connect and
     * the `'auto'`-mode fallback path (same connection, same `initialize` body,
     * zero 2026 headers). Callers clear the negotiated protocol version before
     * the handshake; its completion sets the negotiated (legacy) version.
     */
    private async _legacyHandshake(transport: Transport, options?: RequestOptions): Promise<void> {
        // initialize is a legacy-era handshake: only the legacy subset of the
        // supported versions is ever offered or accepted here — a 2026-era
        // revision is negotiated exclusively via server/discover.
        const legacyVersions = legacyProtocolVersions(this._supportedProtocolVersions);
        try {
            const offeredVersion = legacyVersions[0];
            if (offeredVersion === undefined) {
                throw new SdkError(
                    SdkErrorCode.EraNegotiationFailed,
                    'Cannot run the initialize handshake: supportedProtocolVersions contains no pre-2026-07-28 protocol version'
                );
            }
            const result = await this.request(
                {
                    method: 'initialize',
                    params: {
                        protocolVersion: offeredVersion,
                        capabilities: this._capabilities,
                        clientInfo: this._clientInfo
                    }
                },
                options
            );

            if (result === undefined) {
                throw new Error(`Server sent invalid initialize result: ${result}`);
            }

            if (!legacyVersions.includes(result.protocolVersion)) {
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

            // Handshake completion: the negotiated version becomes the
            // instance's connection state, and with it the wire era for
            // everything this connection sends/receives from here on (the
            // negotiated version cashes out as the negotiated wire ERA —
            // Q1-SD1). Set AFTER the initialized notification: the initialize
            // EXCHANGE is the legacy handshake by definition and completes on
            // that era.
            this._negotiatedProtocolVersion = result.protocolVersion;

            // Set up list changed handlers now that we know server capabilities
            if (this._listChangedConfig) {
                this._setupListChangedHandlers(this._listChangedConfig);
            }
        } catch (error) {
            // Disconnect if initialization fails.
            void this.close();
            throw error;
        }
    }

    /**
     * Negotiated connect (mode `'auto'` or `{ pin }`): probe with `server/discover`
     * before the Protocol machinery attaches, then either establish the modern era
     * or perform the plain legacy handshake on the same connection.
     */
    private async _connectNegotiated(
        transport: Transport,
        negotiation: Extract<ResolvedVersionNegotiation, { kind: 'auto' | 'pin' }>,
        options?: RequestOptions
    ): Promise<void> {
        // Session-resuming reconnect: restore the previously negotiated version,
        // never re-probe mid-session.
        if (transport.sessionId !== undefined) {
            await super.connect(transport);
            const negotiatedProtocolVersion = this._negotiatedProtocolVersion;
            if (negotiatedProtocolVersion !== undefined && transport.setProtocolVersion) {
                transport.setProtocolVersion(negotiatedProtocolVersion);
            }
            return;
        }

        // Fresh connect: stale connection state must not survive into a new
        // negotiation — every fresh negotiated connect re-runs the probe.
        this._resetConnectionState();

        let result: Awaited<ReturnType<typeof negotiateEra>>;
        try {
            result = await negotiateEra(negotiation, {
                transport,
                clientInfo: this._clientInfo,
                capabilities: this._capabilities,
                environment: detectProbeEnvironment(),
                transportKind: detectProbeTransportKind(transport),
                defaultTimeoutMs: options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC
            });
        } catch (error) {
            // Typed connect error — close the channel like a failed initialize does.
            await transport.close().catch(() => {});
            throw error;
        }

        await super.connect(transport);

        if (result.era === 'legacy') {
            // Conservative fallback: the plain legacy handshake on the SAME
            // connection (the probe never touched the transport version slot).
            await this._legacyHandshake(transport, options);
            return;
        }

        this._serverCapabilities = result.discover.capabilities;
        this._serverVersion = result.discover.serverInfo;
        this._instructions = result.discover.instructions;
        // Modern selection: the same connection state the legacy handshake completion sets.
        this._negotiatedProtocolVersion = result.version;
        // The single setProtocolVersion call site on this path, mirroring the legacy path after initialize.
        if (transport.setProtocolVersion) {
            transport.setProtocolVersion(result.version);
        }
        // The modern era has no notifications/initialized; list-changed handlers
        // are configured straight from the advertised capabilities. On a modern
        // connection the configured handlers are fed by an auto-opened
        // subscriptions/listen stream (the modern era never delivers change
        // notifications unsolicited); on a legacy connection they fire on the
        // 2025-era unsolicited notifications, no listen needed.
        if (this._listChangedConfig) {
            const config = this._listChangedConfig;
            // Compute configured ∩ server-advertised ONCE and use that single
            // value for BOTH handler registration and the auto-open filter, so
            // a configured-but-not-advertised type is neither subscribed to
            // nor handled (the two stay in lockstep).
            const advertised = this._serverCapabilities;
            const effective: ListChangedHandlers = {
                ...(config.tools && advertised?.tools?.listChanged && { tools: config.tools }),
                ...(config.prompts && advertised?.prompts?.listChanged && { prompts: config.prompts }),
                ...(config.resources && advertised?.resources?.listChanged && { resources: config.resources })
            };
            // Handler registration validates the per-type options and can
            // throw on misconfiguration; the modern connection IS established
            // at this point and is fully usable without listChanged handlers,
            // so a misconfiguration surfaces via onerror and connect resolves
            // (matching the auto-open soft-fail posture). When registration
            // fails the auto-open is SKIPPED — opening a listen stream for
            // types whose handler never registered would consume a server
            // slot to deliver notifications nothing handles.
            let handlersRegistered = true;
            try {
                this._setupListChangedHandlers(effective);
            } catch (error) {
                handlersRegistered = false;
                this.onerror?.(error instanceof Error ? error : new Error(String(error)));
            }
            const filter: SubscriptionFilter = handlersRegistered
                ? {
                      ...(effective.tools && { toolsListChanged: true as const }),
                      ...(effective.prompts && { promptsListChanged: true as const }),
                      ...(effective.resources && { resourcesListChanged: true as const })
                  }
                : {};
            if (Object.keys(filter).length > 0) {
                // A failed auto-open MUST NOT fail connect: the modern
                // connection is fully usable without a listen stream (the
                // server may not support it, or refuse on capacity). Surface
                // via onerror; the consumer can call listen() later.
                //
                // listen() binds RequestOptions.signal to the SUBSCRIPTION
                // lifetime, so connect()'s signal must NOT be forwarded
                // verbatim — a connect-scoped `AbortSignal.timeout(30_000)`
                // would silently tear the auto-opened stream down the moment
                // it fires after connect has resolved. But connect()'s signal
                // MUST still cancel the in-connect ack WAIT (otherwise an
                // aborted connect blocks here for the full ack timeout).
                // Derived one-shot: bound to connect()'s signal only for the
                // duration of the listen() await; the listener is removed in
                // `finally` so the auto-opened subscription outlives connect's
                // signal.
                const ackAbort = new AbortController();
                const onConnectAbort = (): void => ackAbort.abort(options?.signal?.reason);
                // Handle the already-aborted case (aborted between the
                // discover leg resolving and now): the listener never fires
                // for a past event.
                if (options?.signal?.aborted) onConnectAbort();
                options?.signal?.addEventListener('abort', onConnectAbort);
                try {
                    this._autoOpenedSubscription = await this.listen(filter, {
                        timeout: options?.timeout,
                        signal: ackAbort.signal
                    });
                } catch (error) {
                    // Connect-signal abort during the ack wait propagates as a
                    // connect() rejection (caller asked to abort connect). The
                    // transport is already started, so close it before
                    // rethrowing — a connect() rejection MUST NOT leave a
                    // half-open connection. A server-side refusal stays a
                    // soft onerror (connect succeeds, no listen stream).
                    if (options?.signal?.aborted) {
                        await this.close().catch(() => {});
                        throw error;
                    }
                    this.onerror?.(error instanceof Error ? error : new Error(String(error)));
                } finally {
                    options?.signal?.removeEventListener('abort', onConnectAbort);
                }
            }
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
     * After initialization has completed, this returns the protocol era of the
     * connection: `'modern'` when the connection negotiated a 2026-07-28+
     * revision (via `server/discover`), `'legacy'` for the 2025-era
     * `initialize` handshake, or `undefined` before the connection is
     * established.
     */
    getProtocolEra(): ProtocolEra | undefined {
        const version = this._negotiatedProtocolVersion;
        if (version === undefined) return undefined;
        return isModernProtocolVersion(version) ? 'modern' : 'legacy';
    }

    /**
     * After initialization has completed, this may be populated with information about the server's instructions.
     */
    getInstructions(): string | undefined {
        return this._instructions;
    }

    protected assertCapabilityForMethod(method: RequestMethod | string): void {
        switch (method as ClientRequest['method']) {
            // Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
            // functional during the deprecation window (at least twelve months).
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

            case 'server/discover': {
                // No specific capability required for discover (protocol revision
                // 2026-07-28; servers on that revision MUST implement it)
                break;
            }

            case 'ping': {
                // No specific capability required for ping
                break;
            }
        }
    }

    protected assertNotificationCapability(method: NotificationMethod | string): void {
        switch (method as ClientNotification['method']) {
            // Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
            // functional during the deprecation window (at least twelve months).
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
            // Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
            // functional during the deprecation window (at least twelve months).
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

            // Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
            // functional during the deprecation window (at least twelve months).
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

    async ping(options?: RequestOptions): Promise<EmptyResult> {
        return this.request({ method: 'ping' }, options);
    }

    /**
     * Asks the server to advertise its supported protocol versions, capabilities,
     * and implementation info (`server/discover`, protocol revision 2026-07-28).
     *
     * Servers on the 2026-07-28 revision MUST implement this; the connect-time
     * version negotiation issues it automatically. The method exists only on
     * the 2026-07-28 era: on a connection negotiated to a 2025-era version it
     * is rejected locally with a typed `SdkError`
     * (`MethodNotSupportedByProtocolVersion`) before anything reaches the
     * transport.
     */
    async discover(options?: RequestOptions): Promise<DiscoverResult> {
        return this._requestWithSchema({ method: 'server/discover' }, DiscoverResultSchema, options);
    }

    /** Requests argument autocompletion suggestions from the server for a prompt or resource. */
    async complete(params: CompleteRequest['params'], options?: RequestOptions): Promise<CompleteResult> {
        return this.request({ method: 'completion/complete', params }, options);
    }

    /**
     * Sets the minimum severity level for log messages sent by the server.
     *
     * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
     * Remains functional during the deprecation window (at least twelve months).
     * Migrate to stderr logging (STDIO servers) or OpenTelemetry.
     */
    async setLoggingLevel(level: LoggingLevel, options?: RequestOptions): Promise<EmptyResult> {
        return this.request({ method: 'logging/setLevel', params: { level } }, options);
    }

    /** Retrieves a prompt by name from the server, passing the given arguments for template substitution. */
    async getPrompt(params: GetPromptRequest['params'], options?: RequestOptions): Promise<GetPromptResult> {
        return this.request({ method: 'prompts/get', params }, options);
    }

    /**
     * Lists available prompts.
     *
     * Called without a `cursor` (the common case), this walks every page and
     * returns the complete aggregated list with `nextCursor: undefined`; the
     * aggregate is also written to the {@linkcode ResponseCacheStore}. Pass an
     * explicit `{ cursor }` to fetch a single page and walk pagination
     * yourself — the per-page path returns the server's raw page (with
     * `nextCursor` for the next call) and does not write the response cache.
     * The auto-aggregate path is capped by
     * {@linkcode ClientOptions | ClientOptions.listMaxPages} (default 64); the per-page path
     * is not.
     *
     * Returns an empty list if the server does not advertise prompts capability
     * (or throws if {@linkcode ClientOptions.enforceStrictCapabilities} is enabled).
     *
     * @example
     * ```ts source="./client.examples.ts#Client_listPrompts_pagination"
     * // No cursor → all pages aggregated for you.
     * const { prompts } = await client.listPrompts();
     * console.log(
     *     'Available prompts:',
     *     prompts.map(p => p.name)
     * );
     * ```
     */
    async listPrompts(params?: ListPromptsRequest['params'], options?: RequestOptions): Promise<ListPromptsResult> {
        if (!this._serverCapabilities?.prompts && !this._enforceStrictCapabilities) {
            // Respect capability negotiation: server does not support prompts
            console.debug('Client.listPrompts() called but server does not advertise prompts capability - returning empty list');
            return { prompts: [] };
        }
        if (params?.cursor !== undefined) {
            return this.request({ method: 'prompts/list', params }, options);
        }
        return this._listAllPages<ListPromptsResult>('prompts/list', params, options, (acc, page) => acc.prompts.push(...page.prompts));
    }

    /**
     * Lists available resources.
     *
     * Called without a `cursor` (the common case), this walks every page and
     * returns the complete aggregated list with `nextCursor: undefined`; the
     * aggregate is also written to the {@linkcode ResponseCacheStore}. Pass an
     * explicit `{ cursor }` to fetch a single page and walk pagination
     * yourself — the per-page path returns the server's raw page (with
     * `nextCursor` for the next call) and does not write the response cache.
     * The auto-aggregate path is capped by
     * {@linkcode ClientOptions | ClientOptions.listMaxPages} (default 64); the per-page path
     * is not.
     *
     * Returns an empty list if the server does not advertise resources capability
     * (or throws if {@linkcode ClientOptions.enforceStrictCapabilities} is enabled).
     *
     * @example
     * ```ts source="./client.examples.ts#Client_listResources_pagination"
     * // No cursor → all pages aggregated for you.
     * const { resources } = await client.listResources();
     * console.log(
     *     'Available resources:',
     *     resources.map(r => r.name)
     * );
     * ```
     */
    async listResources(params?: ListResourcesRequest['params'], options?: RequestOptions): Promise<ListResourcesResult> {
        if (!this._serverCapabilities?.resources && !this._enforceStrictCapabilities) {
            // Respect capability negotiation: server does not support resources
            console.debug('Client.listResources() called but server does not advertise resources capability - returning empty list');
            return { resources: [] };
        }
        if (params?.cursor !== undefined) {
            return this.request({ method: 'resources/list', params }, options);
        }
        return this._listAllPages<ListResourcesResult>('resources/list', params, options, (acc, page) =>
            acc.resources.push(...page.resources)
        );
    }

    /**
     * Lists available resource URI templates for dynamic resources.
     *
     * Called without a `cursor`, this walks every page and returns the
     * complete aggregated list with `nextCursor: undefined`; the aggregate is
     * also written to the {@linkcode ResponseCacheStore}. Pass an explicit
     * `{ cursor }` to fetch a single page — see
     * {@linkcode listResources | listResources()} for the per-page contract.
     *
     * Returns an empty list if the server does not advertise resources capability
     * (or throws if {@linkcode ClientOptions.enforceStrictCapabilities} is enabled).
     */
    async listResourceTemplates(
        params?: ListResourceTemplatesRequest['params'],
        options?: RequestOptions
    ): Promise<ListResourceTemplatesResult> {
        if (!this._serverCapabilities?.resources && !this._enforceStrictCapabilities) {
            // Respect capability negotiation: server does not support resources
            console.debug(
                'Client.listResourceTemplates() called but server does not advertise resources capability - returning empty list'
            );
            return { resourceTemplates: [] };
        }
        if (params?.cursor !== undefined) {
            return this.request({ method: 'resources/templates/list', params }, options);
        }
        return this._listAllPages<ListResourceTemplatesResult>('resources/templates/list', params, options, (acc, page) =>
            acc.resourceTemplates.push(...page.resourceTemplates)
        );
    }

    /**
     * Walk every page of a paginated list verb, aggregate, and write ONE
     * entry to the response cache. Internal — backs the public `list*`
     * methods' no-`cursor` auto-aggregate path. Page 1's result object is
     * mutated in place (its items array is extended; `nextCursor` is
     * cleared); page-1 metadata (`ttlMs`, `cacheScope`, `_meta`) is preserved.
     * A `nextCursor` that repeats stops the walk (defence against a
     * non-converging server, mcp.d's `drainList` guard);
     * {@linkcode ClientOptions.listMaxPages} is a hard cap — hitting it
     * throws, so a partial aggregate is never cached. The
     * captured-generation guard skips the write when a `list_changed` landed
     * mid-walk, so the eviction is never overwritten by a stale aggregate.
     * `finalize` runs on the complete aggregate before the cache write — the
     * SEP-2243 invalid-`x-mcp-header` exclusion hooks here so the cached
     * `tools/list` entry is already filtered.
     *
     * The caller's `baseParams` (everything except `cursor`) is threaded into
     * every page request — page 1 sends `{...baseParams}`, later pages
     * `{...baseParams, cursor}` — so a typed, documented `_meta` (e.g. W3C
     * trace context) supplied to the public `list*()` reaches every wire
     * request the walk issues.
     */
    private async _listAllPages<R extends { nextCursor?: string }>(
        method: RequestMethod,
        baseParams: { readonly [key: string]: unknown } | undefined,
        options: RequestOptions | undefined,
        append: (acc: R, page: R) => void,
        finalize?: (acc: R) => void
    ): Promise<R> {
        // Capture the eviction generation BEFORE page 1: a `list_changed` that
        // lands mid-walk bumps the counter, and the terminal `write` skips
        // when it observes the bump (the result still returns to the caller —
        // it just is not cached).
        const generation = this._cache.captureGeneration(method);
        const acc = (await this.request({ method, ...(baseParams && { params: { ...baseParams } }) }, options)) as R;
        let cursor = acc.nextCursor;
        const seen = new Set<string>();
        let pages = 1;
        while (cursor !== undefined && !seen.has(cursor)) {
            if (this._listMaxPages !== 0 && pages >= this._listMaxPages) {
                throw new SdkError(
                    SdkErrorCode.ListPaginationExceeded,
                    `${method}: exceeded listMaxPages (${this._listMaxPages}); server pagination did not terminate`,
                    { method, listMaxPages: this._listMaxPages }
                );
            }
            seen.add(cursor);
            const page = (await this.request({ method, params: { ...baseParams, cursor } }, options)) as R;
            append(acc, page);
            cursor = page.nextCursor;
            pages++;
        }
        acc.nextCursor = undefined;
        finalize?.(acc);
        await this._cache.write(method, acc, generation);
        return acc;
    }

    /** Route a custom-store failure to `onerror` without aborting the surrounding dispatch. */
    private _reportStoreError(e: unknown): void {
        this.onerror?.(e instanceof Error ? e : new Error(String(e)));
    }

    /**
     * Compile a single tool's `outputSchema` (or `undefined` when absent /
     * uncompilable) — the caller-supplied-definition path of
     * {@linkcode callTool} so an explicit `options.toolDefinition` is the
     * source for BOTH mirroring AND output validation. Also passed as the
     * compile callback to {@linkcode ClientResponseCache.outputValidator} so
     * the cache class stays free of any validator-provider dependency.
     */
    private _compileOutputValidator(tool: Tool): JsonSchemaValidator<unknown> | undefined {
        if (!tool.outputSchema) return undefined;
        try {
            return this._jsonSchemaValidator.getValidator(tool.outputSchema as JsonSchemaType);
        } catch (error) {
            console.warn(
                `[mcp-sdk] tool '${tool.name}': outputSchema failed to compile and will not be validated — ${error instanceof Error ? error.message : String(error)}`
            );
            return undefined;
        }
    }

    /**
     * Resolve the SEP-2243 `x-mcp-header` declaration scan for a tool name.
     *
     * The caller-supplied `toolDefinition` escape hatch wins; otherwise the
     * cached `tools/list` entry (via the cache's `toolDefinition`) is the
     * source. Freshness is the response cache's lifecycle: `list_changed`
     * evicts, otherwise the held schema is the best information available
     * regardless of age, and a stale schema is recovered through the
     * `HEADER_MISMATCH` → evict-refetch-retry path in {@linkcode callTool}.
     * On a miss the call proceeds without `Mcp-Param-*` headers (the spec's
     * "client SHOULD send without custom headers" guidance) and relies on the
     * same recovery.
     */
    private async _resolveXMcpHeaderScan(name: string, override: Tool | undefined): Promise<XMcpHeaderScanResult | undefined> {
        const tool = override ?? (await this._cache.toolDefinition(name));
        return tool === undefined ? undefined : scanXMcpHeaderDeclarations(tool.inputSchema);
    }

    /** Reads the contents of a resource by URI. */
    async readResource(params: ReadResourceRequest['params'], options?: RequestOptions): Promise<ReadResourceResult> {
        return this.request({ method: 'resources/read', params }, options);
    }

    /** Subscribes to change notifications for a resource. The server must support resource subscriptions. */
    async subscribeResource(params: SubscribeRequest['params'], options?: RequestOptions): Promise<EmptyResult> {
        return this.request({ method: 'resources/subscribe', params }, options);
    }

    /** Unsubscribes from change notifications for a resource. */
    async unsubscribeResource(params: UnsubscribeRequest['params'], options?: RequestOptions): Promise<EmptyResult> {
        return this.request({ method: 'resources/unsubscribe', params }, options);
    }

    /**
     * Opens a `subscriptions/listen` stream (protocol revision 2026-07-28).
     *
     * Resolves once the server's `notifications/subscriptions/acknowledged`
     * arrives (the standard request timeout applies to this ack phase). Change
     * notifications delivered on the stream are dispatched to the existing
     * {@linkcode setNotificationHandler} registrations — the same handlers the
     * 2025-era unsolicited notifications fire on a legacy connection — so
     * `listen()` is era-transparent for consumers that already register those.
     *
     * `close()` tears the subscription down by aborting the listen request's
     * `requestSignal` (closes the SSE stream where the transport honors it)
     * AND sending `notifications/cancelled` referencing the listen request id
     * — both, unconditionally, so any spec-compliant server on any transport
     * sees the cancel. No automatic re-listen — call `listen()` again to
     * re-establish.
     *
     * On a 2025-era connection this throws a typed
     * {@linkcode SdkErrorCode.MethodNotSupportedByProtocolVersion} steering to
     * `resources/subscribe` and `ClientOptions.listChanged` (the legacy
     * unsolicited delivery model still applies there); no transparent shim.
     */
    async listen(filter: SubscriptionFilter, options?: RequestOptions): Promise<McpSubscription> {
        // Connectivity is checked first so a closed instance rejects with
        // NotConnected (no setup or ack timer is started); after close(),
        // `_resetConnectionState` has also cleared the negotiated era, so the
        // era guard alone would surface a misleading
        // MethodNotSupportedByProtocolVersion.
        if (this.transport === undefined) {
            throw new SdkError(SdkErrorCode.NotConnected, 'Not connected');
        }
        const negotiated = this._negotiatedProtocolVersion;
        if (negotiated === undefined || !isModernProtocolVersion(negotiated)) {
            throw new SdkError(
                SdkErrorCode.MethodNotSupportedByProtocolVersion,
                `subscriptions/listen requires a 2026-07-28-era connection (negotiated: ${negotiated ?? 'none'}). ` +
                    'On a 2025-era connection, change notifications are delivered unsolicited: use ClientOptions.listChanged ' +
                    'and resources/subscribe instead.',
                { method: 'subscriptions/listen', protocolVersion: negotiated }
            );
        }

        // Honor RequestOptions.signal exactly as request() does: an
        // already-aborted signal rejects synchronously before any setup.
        options?.signal?.throwIfAborted();

        const requestAbort = new AbortController();
        // The listen request's JSON-RPC id (= the spec's subscription id
        // verbatim). A STRING from a Client-owned counter so it cannot
        // collide with Protocol's numeric `_requestMessageId` counter — the
        // `_onresponse`/`_onnotification` overrides demux by string-id alone.
        const listenId = `listen:${this._nextListenId++}`;

        // Explicit `opening → open → closed` state machine. Every termination
        // path — ack-arrives, ack-timeout, server-cancelled, user-close,
        // stream-end, transport-close, send-failure — funnels through the
        // single `settle` below, which clears the ack timer, transitions
        // state, and resolves/rejects the opening promise exactly once. The
        // cancelled-before-ack / close-before-ack hangs are impossible by
        // construction.
        let state: 'opening' | 'open' | 'closed' = 'opening';
        let ackTimer: ReturnType<typeof setTimeout> | undefined;
        let onCallerAbort: (() => void) | undefined;
        let resolveOpening!: (honored: SubscriptionFilter) => void;
        let rejectOpening!: (error: Error) => void;
        const opening = new Promise<SubscriptionFilter>((resolve, reject) => {
            resolveOpening = resolve;
            rejectOpening = reject;
        });
        // The McpSubscription.closed observation. Resolved exactly once by
        // settle()'s `→ closed` transition; never rejects. When listen()
        // itself rejects (pre-ack) there is no McpSubscription to observe it
        // on — settle() resolves it anyway so nothing dangles.
        let resolveClosed!: (cause: 'local' | 'remote') => void;
        const closed = new Promise<'local' | 'remote'>(resolve => {
            resolveClosed = resolve;
        });

        const settle = (outcome: { ack: SubscriptionFilter } | { cause: 'local' | 'remote'; error?: Error }): void => {
            if (state === 'closed') return;
            const wasOpening = state === 'opening';
            if (ackTimer !== undefined) {
                clearTimeout(ackTimer);
                ackTimer = undefined;
            }
            if ('ack' in outcome) {
                // The single `opening → open` transition; an ack after close
                // hits the `closed` guard above and is a no-op.
                state = 'open';
                resolveOpening(outcome.ack);
                return;
            }
            state = 'closed';
            if (onCallerAbort !== undefined) {
                options?.signal?.removeEventListener('abort', onCallerAbort);
            }
            this._listenState.delete(listenId);
            // Abort the per-request signal so an HTTP SSE reader stops on a
            // remote-initiated close too (server-cancel / stream-end /
            // transport-drop). Idempotent; a no-op on transports that ignore
            // requestSignal. wireTeardown() also aborts on the local paths —
            // harmless redundancy.
            requestAbort.abort();
            resolveClosed(outcome.cause);
            if (wasOpening) {
                rejectOpening(
                    outcome.error ??
                        new SdkError(SdkErrorCode.ConnectionClosed, 'subscriptions/listen closed before the server acknowledged')
                );
            }
        };

        // Wire-level teardown for a locally-initiated close (user close, ack
        // timeout, caller-signal abort). Transport-agnostic: ALWAYS abort the
        // request signal (closes the SSE stream where the transport honors
        // `requestSignal` — HTTP does, stdio does not) AND send
        // `notifications/cancelled` referencing the listen id (which the
        // stdio listen router and any spec-compliant server honor). Sent via
        // `notification()` so the modern auto-envelope is attached exactly as
        // for every other outbound. Idempotent over HTTP — the cancelled
        // notification is a no-op once the stream is gone; correct on every
        // other transport. Not called when the server already terminated.
        const wireTeardown = async (): Promise<void> => {
            requestAbort.abort();
            await this.notification({ method: 'notifications/cancelled', params: { requestId: listenId } }).catch(() => {});
        };

        const close = async (): Promise<void> => {
            if (state === 'closed') return;
            settle({ cause: 'local' });
            await wireTeardown();
        };

        // The per-subscription state is registered BEFORE the request is sent
        // so a synchronously-delivered ack (an in-process transport) cannot
        // race the registration.
        this._listenState.set(listenId, { settle });

        const ackTimeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
        ackTimer = setTimeout(() => {
            settle({
                cause: 'remote',
                error: new SdkError(SdkErrorCode.RequestTimeout, 'subscriptions/listen ack timed out', { timeout: ackTimeout })
            });
            void wireTeardown().catch(() => {});
        }, ackTimeout);

        // RequestOptions.signal aborts the subscription at any point in its
        // lifecycle (mirrors request()'s cancel path). While `opening`, settle
        // rejects the pending listen() promise with the signal's reason; while
        // `open`, it transitions to `closed` (`closed` resolves `'local'`) and
        // tears the wire down. The listener is removed by `settle()` once the
        // subscription has closed.
        if (options?.signal) {
            const callerSignal = options.signal;
            onCallerAbort = () => {
                if (state === 'closed') return;
                const reason = callerSignal.reason;
                settle({ cause: 'local', error: reason instanceof Error ? reason : new Error(String(reason ?? 'Aborted')) });
                void wireTeardown().catch(() => {});
            };
            callerSignal.addEventListener('abort', onCallerAbort, { once: true });
        }

        // Send the listen request directly on the transport. The `_meta`
        // envelope is built via the same `_outboundMetaEnvelope()` seam every
        // other outbound uses (so a future envelope key cannot silently
        // diverge here). `onRequestStreamEnd` feeds the per-request stream's
        // non-deliberate end into the state machine on transports that open
        // one (Streamable HTTP); stdio/InMemory ignore it.
        const jsonrpcRequest: JSONRPCRequest = {
            jsonrpc: '2.0',
            id: listenId,
            method: 'subscriptions/listen',
            params: { _meta: { ...this._outboundMetaEnvelope() }, notifications: filter }
        };
        try {
            await this.transport.send(jsonrpcRequest, {
                requestSignal: requestAbort.signal,
                onRequestStreamEnd: () => settle({ cause: 'remote', error: new Error('subscriptions/listen: stream ended') })
            });
        } catch (error) {
            // Synchronous OR awaited send failure (including a per-request
            // abort fired before response headers — `streamableHttp._send`
            // rethrows with onerror suppressed). `settle()` is idempotent so
            // a locally-aborted send hitting this path after `close()` is a
            // no-op.
            settle({ cause: 'remote', error: error instanceof Error ? error : new Error(String(error)) });
        }

        const honored = await opening;
        return { honoredFilter: honored, close, closed };
    }

    /**
     * The subscription auto-opened by `ClientOptions.listChanged` on a modern
     * connection — the listen filter is the intersection of the configured
     * sub-options and the server-advertised `listChanged` capabilities.
     * `undefined` on a legacy connection, before connect, or when that
     * intersection is empty (auto-open skipped). Exposed so the consumer can
     * `close()` it.
     */
    get autoOpenedSubscription(): McpSubscription | undefined {
        return this._autoOpenedSubscription;
    }

    /**
     * Transport-level demux for `subscriptions/listen` notifications, before
     * any decoding/era-gating/handler dispatch. Consumes the leading
     * `notifications/subscriptions/acknowledged` referencing a live
     * subscription id (resolves the ack waiter) and an inbound
     * `notifications/cancelled` referencing a live string-typed subscription
     * id (server-side teardown on stdio). Change notifications carrying a
     * subscription id pass through to the existing registered handlers via
     * `super`. An unmatched ack/cancelled is NOT consumed: it reaches
     * `setNotificationHandler` / `fallbackNotificationHandler` instead of
     * being silently swallowed.
     */
    protected override _onnotification(raw: JSONRPCNotification, extra?: MessageExtraInfo): void {
        // Response-cache invalidation: a `list_changed` notification means the
        // matching cached list result is stale. Evict (do NOT refetch) before
        // dispatch so a handler that reaches the cache observes the cleared
        // entry. Runs regardless of whether the user
        // configured `listChanged` — derived views (the tool index, output
        // validators) must drop the stale entry either way. `raw.method` is
        // server-controlled; guard with `Object.hasOwn` so an inherited
        // `Object.prototype` member name (`constructor`, `toString`, …) does
        // not reach the iteration as a non-iterable function.
        const evicted = Object.hasOwn(LIST_CHANGED_EVICTIONS, raw.method) ? LIST_CHANGED_EVICTIONS[raw.method] : undefined;
        if (evicted !== undefined) {
            for (const method of evicted) {
                // `evict()` bumps the generation FIRST and unconditionally
                // (the `_cacheListResult` race guard relies on the bump, not
                // on the store's evict completing), then awaits the store. A
                // custom store's `evict()` may throw or reject; route to
                // `onerror` and proceed so dispatch (and the user's
                // `listChanged` handler) runs regardless. Fire-and-forget —
                // dispatch must not block on an async store.
                void this._cache.evict(method).catch(error => this._reportStoreError(error));
            }
        }
        if (raw.method === 'notifications/subscriptions/acknowledged') {
            const params = raw.params as { _meta?: Record<string, unknown>; notifications?: unknown } | undefined;
            const subscriptionId = params?._meta?.[SUBSCRIPTION_ID_META_KEY];
            const entry = typeof subscriptionId === 'string' ? this._listenState.get(subscriptionId) : undefined;
            if (entry !== undefined) {
                const honored = SubscriptionFilterSchema.safeParse(params?.notifications ?? {});
                entry.settle({ ack: honored.success ? honored.data : {} });
                return;
            }
        }
        if (raw.method === 'notifications/cancelled') {
            const cancelledId = (raw.params as { requestId?: unknown } | undefined)?.requestId;
            const entry = typeof cancelledId === 'string' ? this._listenState.get(cancelledId) : undefined;
            if (entry !== undefined) {
                // Handles BOTH the pre-ack and post-ack server-side cancel:
                // while opening, settle rejects the pending listen() promise;
                // once open, settle transitions to closed and `closed` resolves
                // 'remote' so the consumer can observe the server-initiated
                // close.
                entry.settle({ cause: 'remote', error: new Error('subscriptions/listen: server cancelled the subscription') });
                return;
            }
        }
        super._onnotification(raw, extra);
    }

    /**
     * Transport-level demux for `subscriptions/listen` responses. The spec
     * defines listen as never receiving a JSON-RPC result; a JSON-RPC ERROR
     * for the listen id is the server's pre-ack capacity/params rejection. A
     * string-id response that matches a live `_listenState` entry is consumed
     * here (Protocol's `_responseHandlers` map is keyed by NUMBER and never
     * holds a listen id, so passing a string-id response through would
     * surface as "unknown message ID" via `onerror`).
     */
    protected override _onresponse(response: JSONRPCResponse): void {
        const id = response.id;
        const entry = typeof id === 'string' ? this._listenState.get(id) : undefined;
        if (entry !== undefined) {
            if (isJSONRPCErrorResponse(response)) {
                entry.settle({
                    cause: 'remote',
                    error: ProtocolError.fromError(response.error.code, response.error.message, response.error.data)
                });
            } else {
                entry.settle({
                    cause: 'remote',
                    error: new SdkError(
                        SdkErrorCode.InvalidResult,
                        'server answered subscriptions/listen with a result; expected the acknowledged notification'
                    )
                });
            }
            return;
        }
        super._onresponse(response);
    }

    /**
     * Settle every live per-listen state machine on a transport-initiated
     * close (the server dropping the connection on stdio/InMemory) before
     * Protocol's `_onclose` tears the transport down. The base
     * `_responseHandlers` settlement does not reach `_listenState` (listen
     * ids are never registered there), so without this override a remote
     * close would leave an in-flight `listen()` / open `McpSubscription`
     * hanging.
     */
    protected override _onclose(): void {
        if (this._listenState.size > 0) {
            const reason = new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed');
            for (const entry of this._listenState.values()) {
                entry.settle({ cause: 'remote', error: reason });
            }
            this._listenState.clear();
        }
        super._onclose();
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
    async callTool(params: CallToolRequest['params'], options?: CallToolRequestOptions): Promise<CallToolResult> {
        // SEP-2243 `Mcp-Param-*` mirroring (protocol revision 2026-07-28; the
        // 5-step client algorithm, steps 3–5). Modern-era only — the legacy
        // `callTool` path is byte-untouched. Transports that share a single
        // channel (stdio, in-memory) ignore the per-request `headers` option,
        // so the spec's stdio MAY-ignore exemption holds without an explicit
        // branch. In a browser environment, dynamically named `Mcp-Param-*`
        // headers cannot be statically allow-listed for credentialed CORS
        // (`Access-Control-Allow-Headers` admits no wildcard with
        // credentials), so mirroring is skipped. NOTE: a conforming SEP-2243
        // server (including this SDK's own `createMcpHandler`) rejects a
        // `tools/call` whose body carries a non-null value for an
        // `x-mcp-header`-declared parameter when the matching `Mcp-Param-*`
        // header is absent — so a browser client of this SDK cannot
        // successfully call such a tool with that argument present unless the
        // server relaxes the missing-header check. This is a known limitation
        // of running SEP-2243 from a browser; pass `null` for the designated
        // argument or supply `options.toolDefinition` against a relaxed server.
        const mirroringActive = this.getProtocolEra() === 'modern' && detectProbeEnvironment() !== 'browser';
        // Mirroring (and output-schema validation below) read the cached
        // `tools/list` entry directly via `_cache.toolDefinition` /
        // `_cache.outputValidator`. `callTool` never issues a `tools/list`
        // itself — the cache is populated by the caller's own
        // {@linkcode listTools | listTools()} (which now auto-aggregates) and
        // by the `HEADER_MISMATCH` recovery path below. A cold cache means
        // the call proceeds without `Mcp-Param-*` headers (the spec's
        // "client SHOULD send without custom headers" guidance) and without
        // output-schema validation (the v1.x opportunistic behaviour, kept so
        // a legacy/stdio `callTool` still issues zero extra requests).
        const buildSendOptions = async (): Promise<CallToolRequestOptions | undefined> => {
            if (!mirroringActive) return options;
            // A custom store's `get()` may reject (the documented store
            // contract); route that to `onerror` and degrade to sending
            // without `Mcp-Param-*` headers — same posture as a cold cache —
            // rather than aborting the call before it reaches the wire.
            let scan: XMcpHeaderScanResult | undefined;
            try {
                scan = await this._resolveXMcpHeaderScan(params.name, options?.toolDefinition);
            } catch (error) {
                this._reportStoreError(error);
            }
            if (!scan?.valid || scan.declarations.length === 0) return options;
            const paramHeaders = buildMcpParamHeaders(scan.declarations, params.arguments);
            return Object.keys(paramHeaders).length === 0 ? options : { ...options, headers: { ...options?.headers, ...paramHeaders } };
        };

        // The method-keyed request() path validates the era registry's plain
        // CallToolResult schema — with the result map aligned to the typed
        // map there is no wider union to narrow away (Q1-SD2 holds by
        // construction).
        let result: CallToolResult;
        try {
            result = await this.request({ method: 'tools/call', params }, await buildSendOptions());
        } catch (error) {
            // SEP-2243 one-refresh-on-miss: a `HEADER_MISMATCH` rejection on a
            // modern connection means the server enforced an `Mcp-Param-*`
            // header we did not (or could not) send — the cached `tools/list`
            // entry is stale (or cold). Evict it, repopulate via
            // {@linkcode listTools | listTools()} (which auto-aggregates and
            // writes the cache), and retry once with the now-known schema.
            // Never on the legacy era; never when the caller supplied
            // `toolDefinition` (their schema is authoritative).
            const isHeaderMismatch = error instanceof ProtocolError && error.code === HEADER_MISMATCH_ERROR_CODE;
            if (!mirroringActive || !isHeaderMismatch || options?.toolDefinition !== undefined) {
                throw error;
            }
            const refreshOptions = { signal: options?.signal, timeout: options?.timeout };
            // A custom store's `evict()` may throw or reject (the documented
            // store contract); route that to `onerror` and proceed — the
            // generation bump already happened, so the refetch overwrites the
            // stale entry regardless.
            await this._cache.evict('tools/list').catch(error_ => this._reportStoreError(error_));
            // The recovery refetch may itself fail (e.g. `listMaxPages`, a
            // transient error that hits only the `tools/list` walk). Surface
            // it via `onerror` so the real cause is observable, then proceed
            // to the retry. NOTE: when the refetch fails the cache stays
            // empty and the retry goes out without `Mcp-Param-*` headers, so
            // a conforming server will likely answer a second
            // `HEADER_MISMATCH` — the refetch failure is observable only
            // through `onerror`.
            await this.listTools(undefined, refreshOptions).catch(error_ => this._reportStoreError(error_));
            result = await this.request({ method: 'tools/call', params }, await buildSendOptions());
        }

        // Check if the tool has an outputSchema. When the caller supplied
        // `toolDefinition`, that definition is the source for BOTH the
        // `Mcp-Param-*` mirroring above AND the output validation here — the
        // two derived views must agree. The cache read is guarded the same
        // way as `evict()`/`set()` above: a custom store whose `get()`
        // rejects AFTER the server has already executed the call must not
        // surface as a `callTool()` rejection (a caller that retries on
        // failure would re-execute a possibly side-effecting tool). Route to
        // `onerror` and degrade to skipping validation — the same outcome as
        // a cold cache.
        const validator =
            options?.toolDefinition === undefined
                ? await this._cache
                      .outputValidator(params.name, tool => this._compileOutputValidator(tool))
                      .catch(error => void this._reportStoreError(error))
                : this._compileOutputValidator(options.toolDefinition);
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
     * Lists available tools.
     *
     * Called without a `cursor` (the common case), this walks every page and
     * returns the complete aggregated list with `nextCursor: undefined`; the
     * aggregate is also written to the {@linkcode ResponseCacheStore} (the
     * source for {@linkcode callTool | callTool()}'s output-schema validation
     * and SEP-2243 `Mcp-Param-*` header mirroring). Pass an explicit
     * `{ cursor }` to fetch a single page and walk pagination yourself — the
     * per-page path returns the server's raw page (with `nextCursor` for the
     * next call) and does not write the response cache. The auto-aggregate
     * path is capped by {@linkcode ClientOptions | ClientOptions.listMaxPages} (default 64);
     * the per-page path is not.
     *
     * Returns an empty list if the server does not advertise tools capability
     * (or throws if {@linkcode ClientOptions.enforceStrictCapabilities} is enabled).
     *
     * @example
     * ```ts source="./client.examples.ts#Client_listTools_pagination"
     * // No cursor → all pages aggregated for you.
     * const { tools } = await client.listTools();
     * console.log(
     *     'Available tools:',
     *     tools.map(t => t.name)
     * );
     * ```
     */
    async listTools(params?: ListToolsRequest['params'], options?: RequestOptions): Promise<ListToolsResult> {
        if (!this._serverCapabilities?.tools && !this._enforceStrictCapabilities) {
            // Respect capability negotiation: server does not support tools
            console.debug('Client.listTools() called but server does not advertise tools capability - returning empty list');
            return { tools: [] };
        }
        if (params?.cursor !== undefined) {
            // Per-page: single request, never written to the response cache.
            // SEP-2243: the spec's MUST has no carve-out for paginated reads,
            // so the per-page result is filtered (on a non-stdio modern
            // connection) before returning — the suppressed tool is never
            // observable.
            const page = await this.request({ method: 'tools/list', params }, options);
            this._excludeInvalidXMcpHeaderTools(page);
            return page;
        }
        // Auto-aggregate: SEP-2243 invalid-`x-mcp-header` exclusion runs on
        // the complete aggregate via the `finalize` hook before the cache
        // write, so the cached entry never holds an unmirrorable tool.
        return this._listAllPages<ListToolsResult>(
            'tools/list',
            params,
            options,
            (acc, page) => acc.tools.push(...page.tools),
            acc => this._excludeInvalidXMcpHeaderTools(acc)
        );
    }

    /**
     * SEP-2243 (protocol revision 2026-07-28): a Streamable HTTP client MUST
     * exclude tool definitions whose `x-mcp-header` declarations violate the
     * constraints, and SHOULD log a warning naming the tool and the reason.
     * Applied to the CACHED aggregated `tools/list` result (so the entry
     * mirroring reads never holds an unmirrorable tool) AND to every public
     * per-page {@linkcode listTools | listTools()} return (the spec's MUST
     * has no carve-out for paginated reads). The gate is era-only on
     * non-stdio transports — `detectProbeTransportKind` cannot distinguish a
     * real HTTP transport from in-memory/custom transports (it only
     * positively recognizes stdio), and over-excluding on a non-HTTP modern
     * connection is harmless: those transports never carry per-request
     * headers, so an excluded tool would have been uncallable on a Streamable
     * HTTP arm of the same server. Mutates `result.tools` in place.
     */
    private _excludeInvalidXMcpHeaderTools(result: ListToolsResult): void {
        if (this.getProtocolEra() !== 'modern' || !this.transport || detectProbeTransportKind(this.transport) === 'stdio') return;
        const filtered = result.tools.filter(tool => {
            const scan = scanXMcpHeaderDeclarations(tool.inputSchema);
            if (!scan.valid) {
                console.warn(`[mcp-sdk] excluding tool '${tool.name}' from tools/list: invalid x-mcp-header declaration — ${scan.reason}`);
                return false;
            }
            return true;
        });
        if (filtered.length !== result.tools.length) result.tools = filtered;
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
     * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
     * Remains functional during the deprecation window (at least twelve months).
     * Migrate to passing paths via tool parameters, resource URIs, or configuration.
     */
    async sendRootsListChanged() {
        return this.notification({ method: 'notifications/roots/list_changed' });
    }
}
