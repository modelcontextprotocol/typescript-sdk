import type {
    BaseContext,
    CacheHint,
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
    EmptyResult,
    Implementation,
    InitializeRequest,
    InitializeResult,
    JSONRPCNotification,
    JSONRPCRequest,
    JsonSchemaType,
    jsonSchemaValidator,
    ListRootsRequest,
    ListRootsResult,
    LoggingLevel,
    LoggingMessageNotification,
    MessageClassification,
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
    ToolResultContent,
    ToolUseContent
} from '@modelcontextprotocol/core';
import {
    assertValidCacheHint,
    attachCacheHintFallback,
    classifyInboundMessage,
    codecForVersion,
    CreateMessageResultSchema,
    CreateMessageResultWithToolsSchema,
    envelopeClaimVersion,
    FIRST_MODERN_PROTOCOL_VERSION,
    hasEnvelopeClaim,
    isModernProtocolVersion,
    LATEST_PROTOCOL_VERSION,
    legacyProtocolVersions,
    LoggingLevelSchema,
    mergeCapabilities,
    modernProtocolVersions,
    parseSchema,
    Protocol,
    ProtocolError,
    ProtocolErrorCode,
    requestMetaOf,
    SdkError,
    SdkErrorCode,
    SUPPORTED_MODERN_PROTOCOL_VERSIONS,
    validateEnvelopeMeta
} from '@modelcontextprotocol/core';
import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/server/_shims';
import * as z from 'zod/v4';

export type ServerOptions = ProtocolOptions & {
    /**
     * Capabilities to advertise as being supported by this server.
     *
     * Note: per the MCP spec, a server that declares a capability MUST respond to that
     * capability's requests (e.g. `tools/list` for `tools`) — potentially with an empty
     * result — rather than with a "Method not found" error. {@linkcode server/mcp.McpServer | McpServer}
     * handles this automatically for capabilities declared here; when using the low-level
     * {@linkcode Server} directly, you are responsible for registering a request handler for
     * every capability you declare.
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

    /**
     * Which protocol eras this server serves on its long-lived connection
     * (e.g. stdio): the 2025-era `initialize` family, the 2026-07-28
     * per-request-envelope revision, or both.
     *
     * - `'legacy'` (the default) preserves exactly what existing code was
     *   written for: the server speaks the 2025-era protocol negotiated via
     *   `initialize`, never registers or advertises `server/discover`, and
     *   upgrading the SDK changes nothing about what the instance puts on the
     *   wire.
     * - `'dual-era'` serves BOTH eras on the same connection, selecting the
     *   era per message: `initialize`-negotiated 2025 traffic is served as
     *   before, while messages carrying the 2026-07-28 per-request `_meta`
     *   envelope (including `server/discover`) are served on the modern era.
     *   Declaring dual-era support is an explicit act — the consumer asserts
     *   that the server is ready to serve modern-era requests.
     * - `'modern'` is strict 2026-07-28-only: requests without the
     *   per-request envelope (including `initialize`) are answered with the
     *   unsupported-protocol-version error naming the supported revisions.
     *
     * Declaring `'dual-era'` or `'modern'` automatically adds the SDK's
     * supported modern revisions to
     * {@linkcode ProtocolOptions.supportedProtocolVersions}, and `'modern'`
     * serves only those: a strict instance's supported-versions list (what
     * `server/discover` advertises and version-mismatch errors name) is its
     * modern subset.
     *
     * Opting in is one option away and the transport stays unchanged:
     *
     * ```ts
     * const server = new McpServer({ name: 'my-server', version: '1.0.0' }, { eraSupport: 'dual-era' });
     * await server.connect(new StdioServerTransport());
     * ```
     *
     * A 2026-era revision in {@linkcode ProtocolOptions.supportedProtocolVersions}
     * requires `'dual-era'` or `'modern'`; passing one on a (default)
     * `'legacy'` instance throws a `TypeError` at construction.
     *
     * Per-request HTTP serving via `createMcpHandler` does not use this
     * option: the entry classifies each request and binds the per-request
     * instance itself.
     *
     * @default 'legacy'
     */
    eraSupport?: 'legacy' | 'dual-era' | 'modern';

    /**
     * Cache hints for the cacheable results of the 2026-07-28 protocol
     * revision (`ttlMs` / `cacheScope`), keyed by operation. The hint is used
     * when the result for that operation does not provide its own cache
     * fields — most useful for the list results and `server/discover`, which
     * the SDK builds itself. A hint registered with an individual resource
     * (`registerResource(..., { cacheHint })`) takes precedence for that
     * resource's `resources/read` results.
     *
     * Absent hints (or omitting this option entirely) keep today's behavior:
     * cacheable 2026-07-28 results are emitted with `ttlMs: 0` and
     * `cacheScope: 'private'`. Responses to 2025-era requests are never
     * affected. Invalid values throw a `RangeError` at construction time.
     */
    cacheHints?: Partial<
        Record<
            'tools/list' | 'prompts/list' | 'resources/list' | 'resources/templates/list' | 'resources/read' | 'server/discover',
            CacheHint
        >
    >;
};

/**
 * Permissive params schema for the `server/discover` registration on servers
 * that declared modern-era support. The discover request carries only the
 * per-request `_meta` envelope, which the protocol layer lifts and validates
 * before dispatch — and a long-lived dual-era instance is never bound to a
 * single era, so the spec-method registration form (which resolves its
 * dispatch schema from the instance era) cannot be used here.
 */
const DISCOVER_PARAMS_SCHEMA = z.looseObject({});

/**
 * Whether a message's params carry a per-request envelope claim that is both
 * well-formed and names a modern protocol revision.
 *
 * The per-message form of the inbound classifier's `initialize` precedence
 * rule: only such a claim overrides the `initialize` ⇒ legacy-handshake
 * classification — a message carrying a valid modern envelope is a modern
 * request regardless of its method name, and the modern era then answers
 * `initialize` exactly like any other method it does not define
 * (method-not-found). A malformed claim, or one naming a pre-2026 revision,
 * keeps the legacy-handshake routing unchanged.
 */
function carriesValidModernEnvelopeClaim(params: unknown): boolean {
    if (!hasEnvelopeClaim(params)) {
        return false;
    }
    const claimedVersion = envelopeClaimVersion(params);
    if (claimedVersion === undefined || !isModernProtocolVersion(claimedVersion)) {
        return false;
    }
    const meta = requestMetaOf(params);
    return meta !== undefined && validateEnvelopeMeta(meta).length === 0;
}

/*
 * Package-internal hooks for the per-request (2026-07-28) HTTP serving entry.
 *
 * The connection-scoped client-identity fields and the modern-only handler set are
 * private to `Server`; the per-request entry in this package needs to write/install
 * them on the fresh instance it gets from a consumer factory. The static initializer
 * below hands these module-scoped closures privileged access; the exported wrappers
 * are imported by sibling modules in this package only and are deliberately NOT
 * re-exported from the package index (they are not public API).
 */
let writeClientIdentity: (server: Server, identity: PerRequestClientIdentity) => void;
let installDiscoverHandler: (server: Server, servedModernVersions: readonly string[]) => void;

/** Connection-scoped client-identity fields backfilled per request from a validated `_meta` envelope. */
export interface PerRequestClientIdentity {
    /** The client's name/version information, when the envelope carried it. */
    clientInfo?: Implementation;
    /** The client's declared capabilities, when the envelope carried them. */
    clientCapabilities?: ClientCapabilities;
}

/**
 * Package-internal: backfills the connection-scoped client-identity fields of a
 * per-request server instance from the request's validated `_meta` envelope, so the
 * (deprecated) {@linkcode Server.getClientCapabilities} / {@linkcode Server.getClientVersion}
 * accessors keep answering on instances that never see an `initialize` handshake.
 * Not public API.
 */
export function seedClientIdentityFromEnvelope(server: Server, identity: PerRequestClientIdentity): void {
    writeClientIdentity(server, identity);
}

/**
 * Package-internal: installs the modern-only `server/discover` handler on an instance
 * the HTTP entry has marked as serving the 2026-07-28 era, and makes sure the modern
 * revisions the entry serves appear in the instance's supported-versions list (so the
 * discover advertisement and version-mismatch errors name them). Idempotent.
 * Hand-constructed instances are unaffected: nothing else calls this, so they keep
 * answering `-32601` unless their own supported-versions list opts into a modern
 * revision. Not public API.
 */
export function installModernOnlyHandlers(server: Server, servedModernVersions: readonly string[]): void {
    installDiscoverHandler(server, servedModernVersions);
}

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

    static {
        writeClientIdentity = (server, identity) => {
            if (identity.clientCapabilities !== undefined) {
                server._clientCapabilities = identity.clientCapabilities;
            }
            if (identity.clientInfo !== undefined) {
                server._clientVersion = identity.clientInfo;
            }
        };
        installDiscoverHandler = (server, servedModernVersions) => {
            const missing = servedModernVersions.filter(version => !server._supportedProtocolVersions.includes(version));
            if (missing.length > 0) {
                // Never mutate the existing array in place: the default supported-versions
                // list is a shared module constant.
                server._supportedProtocolVersions = [...server._supportedProtocolVersions, ...missing];
            }
            server.setRequestHandler('server/discover', () => server._ondiscover());
        };
    }
    private _capabilities: ServerCapabilities;
    private _instructions?: string;
    private _jsonSchemaValidator: jsonSchemaValidator;
    private _eraSupport: 'legacy' | 'dual-era' | 'modern';
    /**
     * The protocol version a legacy `initialize` handshake negotiated on a
     * dual-era instance. A dual-era instance is never bound to a single era
     * (the era is selected per message), so the handshake result is recorded
     * here only for the initialize-scoped accessor.
     */
    private _dualEraInitializeVersion?: string;
    private _cacheHints?: ServerOptions['cacheHints'];

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
        this._eraSupport = options?.eraSupport ?? 'legacy';

        // Configured cache hints fail loudly at construction time (before any
        // handler registration consults them).
        if (options?.cacheHints !== undefined) {
            for (const [operation, hint] of Object.entries(options.cacheHints)) {
                if (hint !== undefined) {
                    assertValidCacheHint(hint, `cacheHints['${operation}']`);
                }
            }
            this._cacheHints = options.cacheHints;
        }

        this.setRequestHandler('initialize', request => this._oninitialize(request));
        this.setNotificationHandler('notifications/initialized', () => this.oninitialized?.());

        if (this._eraSupport === 'legacy') {
            // The default preserves exactly what the code was written for:
            // 2025-era serving only, nothing 2026-era registered or
            // advertised. Serving a 2026-era revision is a declared act — a
            // modern revision in the supported list without that declaration
            // is a configuration error, never a silent behavior change.
            const modernVersions = modernProtocolVersions(this._supportedProtocolVersions);
            if (modernVersions.length > 0) {
                throw new TypeError(
                    `supportedProtocolVersions contains the protocol revision ${modernVersions[0]}, which this server does not serve ` +
                        `with the default eraSupport of 'legacy'. Declare { eraSupport: 'dual-era' } (serve both eras) or ` +
                        `{ eraSupport: 'modern' } (2026-era only) to serve it.`
                );
            }
        } else {
            // server/discover is registered (and modern revisions advertised)
            // only on servers that declared modern-era support; the served
            // modern revisions are added to the supported list so the
            // advertisement and version-mismatch errors name them (a new
            // array — the shared default constant is never mutated).
            const missing = SUPPORTED_MODERN_PROTOCOL_VERSIONS.filter(version => !this._supportedProtocolVersions.includes(version));
            if (missing.length > 0) {
                this._supportedProtocolVersions = [...this._supportedProtocolVersions, ...missing];
            }
            this.setRequestHandler('server/discover', { params: DISCOVER_PARAMS_SCHEMA }, () => this._ondiscover());
            if (this._eraSupport === 'modern') {
                // A strict modern-only server serves only modern revisions, so
                // the supported list is reduced to its modern subset — keeping
                // the legacy entries would advertise revisions the instance
                // never serves in the unsupported-protocol-version error's
                // supported list, and `initialize` (the only other consumer of
                // the legacy entries) is unreachable on a strict instance.
                this._supportedProtocolVersions = modernProtocolVersions(this._supportedProtocolVersions);
                // A strict modern-only server is bound to the modern era from
                // construction: requests classified into the 2025 era are
                // answered with the typed unsupported-protocol-version error
                // naming the supported revisions, never served.
                this._negotiatedProtocolVersion = this._supportedProtocolVersions[0];
            }
        }

        if (this._capabilities.logging) {
            this._registerLoggingHandler();
        }
    }

    /**
     * Per-message era classification for long-lived dual-era channels (e.g. a
     * stdio server that declared modern-era support). Active only when the
     * consumer opted in: default (`'legacy'`) instances return `undefined`,
     * which keeps their dispatch byte-identical to today's. Transport-edge
     * classification (the per-request HTTP entry) always wins and never
     * reaches this hook.
     */
    protected override _classifyInbound(message: JSONRPCRequest | JSONRPCNotification): MessageClassification | 'drop' | undefined {
        if (this._eraSupport === 'legacy') {
            return undefined;
        }
        // `initialize` is the legacy handshake by definition — unless the
        // message carries a valid envelope claim naming a modern revision, in
        // which case the claim wins: the message is classified like any other
        // enveloped message and served on the modern era, where the era
        // registry answers `initialize` with the same plain method-not-found
        // it answers every other method that era does not define. A malformed
        // or absent claim, or a claim naming a pre-2026 revision, keeps the
        // legacy-handshake classification from the per-message predicate.
        if (message.method === 'initialize' && carriesValidModernEnvelopeClaim(message.params)) {
            const claimedVersion = envelopeClaimVersion(message.params);
            if (claimedVersion !== undefined) {
                return { era: 'modern', revision: claimedVersion };
            }
        }
        return classifyInboundMessage(message);
    }

    /**
     * Registers the built-in `logging/setLevel` request handler.
     *
     * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
     * Remains functional during the deprecation window (at least twelve months).
     * Migrate to stderr logging (STDIO servers) or OpenTelemetry.
     */
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
     * Era gate for context-related server→client requests, keyed off the era
     * of the request currently being served (its classification).
     *
     * A long-lived dual-era instance is never bound to a single era, so the
     * instance-level outbound era gate alone would let a handler that is
     * serving a 2026-era request push a server→client wire request
     * (sampling, elicitation, roots) onto the connection. The 2026-07-28
     * revision has no server→client JSON-RPC request channel, so the client
     * drops the request and the call hangs until timeout. The request
     * context therefore applies the same typed local error a strict
     * `'modern'` instance raises, per request: spec methods absent from the
     * served era's registry fail fast before anything reaches the transport.
     *
     * Scope: the context request path only (`ctx.mcpReq.send`,
     * `ctx.mcpReq.elicitInput`, `ctx.mcpReq.requestSampling`). Related
     * notifications, requests served on the legacy era, and instance-level
     * senders used outside a request context are unaffected.
     */
    private _assertContextRequestInServedEra(classification: MessageClassification | undefined, method: string): void {
        if (classification === undefined) {
            return;
        }
        const servedCodec = codecForVersion(
            classification.revision ?? (classification.era === 'modern' ? FIRST_MODERN_PROTOCOL_VERSION : undefined)
        );
        // Mirrors the outbound era gate: only spec methods missing from the
        // served era are gated; methods the served era defines (and
        // consumer-owned extension methods) resolve exactly as before.
        if (servedCodec.hasRequestMethod(method) || !codecForVersion(undefined).hasRequestMethod(method)) {
            return;
        }
        throw new SdkError(
            SdkErrorCode.MethodNotSupportedByProtocolVersion,
            `Server-to-client requests are not available on protocol revision ${servedCodec.era}: ` +
                `'${method}' cannot be sent while serving a request on that revision. ` +
                `Servers obtain client input through request results once multi-round-trip support is available.`,
            { method, era: servedCodec.era }
        );
    }

    protected override buildContext(ctx: BaseContext, transportInfo?: MessageExtraInfo): ServerContext {
        // Only create http when there's actual HTTP transport info or auth info
        const hasHttpInfo = ctx.http || transportInfo?.request || transportInfo?.closeSSEStream || transportInfo?.closeStandaloneSSEStream;
        const classification = transportInfo?.classification;
        // Context-related server→client requests are gated by the era of the
        // request being served (see _assertContextRequestInServedEra);
        // related notifications (`notify`, `log`) are unaffected.
        const baseSend = ctx.mcpReq.send as (request: { method: string }, ...rest: unknown[]) => Promise<unknown>;
        const send = ((request: { method: string }, ...rest: unknown[]) => {
            this._assertContextRequestInServedEra(classification, request.method);
            return baseSend(request, ...rest);
        }) as BaseContext['mcpReq']['send'];
        return {
            ...ctx,
            mcpReq: {
                ...ctx.mcpReq,
                send,
                // Deprecated as of protocol version 2026-07-28 (SEP-2577): `log` and
                // `requestSampling` remain functional during the deprecation window
                // (at least twelve months). See ServerContext for migration guidance.
                log: (level, data, logger) => this.sendLoggingMessage({ level, data, logger }),
                elicitInput: async (params, options) => {
                    this._assertContextRequestInServedEra(classification, 'elicitation/create');
                    return this.elicitInput(params, options);
                },
                requestSampling: async (params, options) => {
                    this._assertContextRequestInServedEra(classification, 'sampling/createMessage');
                    return this.createMessage(params, options);
                }
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
     * handler was registered, and attaches the configured per-operation cache hint
     * (when one exists) so the 2026-07-28 encode seam can fill `ttlMs`/`cacheScope`
     * for results that do not provide their own. The hint rides a symbol-keyed
     * property that is never serialized, so 2025-era responses are unaffected.
     */
    protected override _wrapHandler(
        method: string,
        handler: (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result>
    ): (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result> {
        if (method !== 'tools/call') {
            const cacheHint = (this._cacheHints as Record<string, CacheHint | undefined> | undefined)?.[method];
            if (cacheHint === undefined) {
                return handler;
            }
            return async (request, ctx) => attachCacheHintFallback(await handler(request, ctx), cacheHint);
        }
        return async (request, ctx) => {
            // Era-exact validation: the request and result schemas come from
            // the instance era, resolved at dispatch time (the era gate
            // guarantees tools/call exists on the serving era).
            const codec = codecForVersion(this._negotiatedProtocolVersion);
            const callToolRequestSchema = codec.requestSchema('tools/call');
            // The era registry entry IS the plain CallToolResult schema (the
            // result map is aligned to the typed map — no widened unions),
            // so no narrower surface is needed.
            const callToolResultSchema = codec.resultSchema('tools/call');
            if (!callToolRequestSchema || !callToolResultSchema) {
                throw new ProtocolError(ProtocolErrorCode.InternalError, 'No wire schema for tools/call in the resolved era');
            }
            const validatedRequest = parseSchema(callToolRequestSchema, request);
            if (!validatedRequest.success) {
                const errorMessage =
                    validatedRequest.error instanceof Error ? validatedRequest.error.message : String(validatedRequest.error);
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid tools/call request: ${errorMessage}`);
            }

            const result = await handler(request, ctx);

            const validationResult = parseSchema(callToolResultSchema, result);
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

        // A 2026-07-28-or-later revision is NEVER negotiated via the legacy
        // `initialize` handshake — only ever selected through `server/discover` —
        // so the accept check and counter-offer consult only the legacy subset.
        const legacyVersions = legacyProtocolVersions(this._supportedProtocolVersions);
        const protocolVersion = legacyVersions.includes(requestedVersion)
            ? requestedVersion
            : (legacyVersions[0] ?? LATEST_PROTOCOL_VERSION);

        // The negotiated version is the instance's connection state — it IS
        // the wire-era selection for everything this instance sends and
        // receives from here on (legacy handshake ⇒ a legacy-era version).
        // The one exception is a dual-era instance: it serves both eras on
        // the same long-lived connection, selecting the era per message, so
        // the handshake never binds the instance — the result is recorded
        // only for the initialize-scoped accessor.
        if (this._eraSupport === 'dual-era') {
            this._dualEraInitializeVersion = protocolVersion;
        } else {
            this._negotiatedProtocolVersion = protocolVersion;
        }
        this.transport?.setProtocolVersion?.(protocolVersion);

        return {
            protocolVersion,
            capabilities: this.getCapabilities(),
            serverInfo: this._serverInfo,
            ...(this._instructions && { instructions: this._instructions })
        };
    }

    /**
     * Answers `server/discover` (protocol revision 2026-07-28). `supportedVersions`
     * lists only modern revisions (2025-era versions are negotiated via `initialize`);
     * the advertised capabilities exclude the listChanged/subscribe-class capabilities
     * (see {@linkcode discoverAdvertisedCapabilities}).
     */
    private _ondiscover(): DiscoverResult {
        return {
            supportedVersions: modernProtocolVersions(this._supportedProtocolVersions),
            capabilities: discoverAdvertisedCapabilities(this.getCapabilities()),
            serverInfo: this._serverInfo,
            ...(this._instructions && { instructions: this._instructions })
        };
    }

    /**
     * After initialization has completed, this will be populated with the client's reported capabilities.
     *
     * @deprecated Read client identity from the per-request handler context instead: on
     * 2026-07-28 (per-request envelope) requests `ctx.mcpReq.envelope` carries the client's
     * declared capabilities, while on 2025-era connections this accessor keeps returning the
     * `initialize`-scoped value. The accessor remains functional — instances serving the
     * 2026-07-28 era are backfilled per request from the validated envelope.
     */
    getClientCapabilities(): ClientCapabilities | undefined {
        return this._clientCapabilities;
    }

    /**
     * After initialization has completed, this will be populated with information about the client's name and version.
     *
     * @deprecated Read client identity from the per-request handler context instead: on
     * 2026-07-28 (per-request envelope) requests `ctx.mcpReq.envelope` carries the client's
     * name and version, while on 2025-era connections this accessor keeps returning the
     * `initialize`-scoped value. The accessor remains functional — instances serving the
     * 2026-07-28 era are backfilled per request from the validated envelope.
     */
    getClientVersion(): Implementation | undefined {
        return this._clientVersion;
    }

    /**
     * After initialization has completed, this will be populated with the protocol version negotiated
     * with the client (the version the server responded with during the initialize handshake), or
     * `undefined` before initialization.
     *
     * @deprecated Read the protocol revision from the per-request handler context instead: on
     * 2026-07-28 (per-request envelope) requests `ctx.mcpReq.envelope` names the revision the
     * request was sent for, while on 2025-era connections this accessor keeps returning the
     * `initialize`-negotiated version. The accessor remains functional — instances serving the
     * 2026-07-28 era report that revision. On a long-lived dual-era instance (`eraSupport:
     * 'dual-era'`), where the era is selected per message, the accessor keeps its
     * initialize-scoped semantics and reports what a legacy `initialize` handshake negotiated
     * (or `undefined` when none ran).
     */
    getNegotiatedProtocolVersion(): string | undefined {
        return this._negotiatedProtocolVersion ?? this._dualEraInitializeVersion;
    }

    /**
     * Returns the current server capabilities.
     */
    public getCapabilities(): ServerCapabilities {
        return this._capabilities;
    }

    async ping(): Promise<EmptyResult> {
        return this.request({ method: 'ping' });
    }

    /**
     * Request LLM sampling from the client (without tools).
     * Returns single content block for backwards compatibility.
     *
     * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
     * Remains functional during the deprecation window (at least twelve months).
     * Migrate to calling LLM provider APIs directly.
     */
    async createMessage(params: CreateMessageRequestParamsBase, options?: RequestOptions): Promise<CreateMessageResult>;

    /**
     * Request LLM sampling from the client with tool support.
     * Returns content that may be a single block or array (for parallel tool calls).
     *
     * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
     * Remains functional during the deprecation window (at least twelve months).
     * Migrate to calling LLM provider APIs directly.
     */
    async createMessage(params: CreateMessageRequestParamsWithTools, options?: RequestOptions): Promise<CreateMessageResultWithTools>;

    /**
     * Request LLM sampling from the client.
     * When tools may or may not be present, returns the union type.
     *
     * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
     * Remains functional during the deprecation window (at least twelve months).
     * Migrate to calling LLM provider APIs directly.
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

        // Use different schemas based on whether tools are provided. The
        // result schema depends on the REQUEST params, which a method-keyed
        // registry entry cannot express, so it goes through the explicit-
        // schema path (still era-gated: sampling/createMessage is not a wire
        // request on the 2026 era, so a modern-era instance fails with the
        // typed era error before anything reaches the transport).
        if (params.tools) {
            return await this._requestWithSchema({ method: 'sampling/createMessage', params }, CreateMessageResultWithToolsSchema, options);
        }
        return await this._requestWithSchema({ method: 'sampling/createMessage', params }, CreateMessageResultSchema, options);
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
                // Method-keyed request(): the era registry's plain
                // ElicitResult schema is exactly the narrow surface.
                return this.request({ method: 'elicitation/create', params: urlParams }, options);
            }
            case 'form': {
                if (!this._clientCapabilities?.elicitation?.form) {
                    throw new SdkError(SdkErrorCode.CapabilityNotSupported, 'Client does not support form elicitation.');
                }

                const formParams: ElicitRequestFormParams =
                    params.mode === 'form' ? (params as ElicitRequestFormParams) : { ...(params as ElicitRequestFormParams), mode: 'form' };

                const result = await this.request({ method: 'elicitation/create', params: formParams }, options);

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

    /**
     * Requests the list of roots from the client.
     *
     * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
     * Remains functional during the deprecation window (at least twelve months).
     * Migrate to passing paths via tool parameters, resource URIs, or configuration.
     */
    async listRoots(params?: ListRootsRequest['params'], options?: RequestOptions): Promise<ListRootsResult> {
        return this.request({ method: 'roots/list', params }, options);
    }

    /**
     * Sends a logging message to the client, if connected.
     * Note: You only need to send the parameters object, not the entire JSON-RPC message.
     * @see {@linkcode LoggingMessageNotification}
     * @param params
     * @param sessionId Optional for stateless transports and backward compatibility.
     *
     * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
     * Remains functional during the deprecation window (at least twelve months).
     * Migrate to stderr logging (STDIO servers) or OpenTelemetry.
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

/**
 * The capability set a server advertises on `server/discover`: until the
 * `subscriptions/listen` flow ships, the advertisement excludes the
 * listChanged/subscribe-class capabilities, which a modern-era connection
 * cannot be served yet. Pure — never mutates the input; the legacy
 * `initialize` advertisement is untouched.
 */
export function discoverAdvertisedCapabilities(capabilities: ServerCapabilities): ServerCapabilities {
    const advertised: ServerCapabilities = { ...capabilities };
    if (capabilities.tools) {
        advertised.tools = { ...capabilities.tools };
        delete advertised.tools.listChanged;
    }
    if (capabilities.prompts) {
        advertised.prompts = { ...capabilities.prompts };
        delete advertised.prompts.listChanged;
    }
    if (capabilities.resources) {
        advertised.resources = { ...capabilities.resources };
        delete advertised.resources.listChanged;
        delete advertised.resources.subscribe;
    }
    return advertised;
}
