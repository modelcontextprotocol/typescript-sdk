import type {
    BaseContext,
    CacheableResultMethod,
    CacheHint,
    CallToolResult,
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
    JSONRPCRequest,
    JsonSchemaType,
    jsonSchemaValidator,
    ListRootsRequest,
    ListRootsResult,
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
    ToolResultContent,
    ToolUseContent
} from '@modelcontextprotocol/core-internal';
import {
    assertValidCacheHint,
    attachCacheHintFallback,
    CLIENT_CAPABILITIES_META_KEY,
    codecForVersion,
    isInputRequiredResult,
    isModernProtocolVersion,
    LATEST_PROTOCOL_VERSION,
    legacyProtocolVersions,
    LOG_LEVEL_META_KEY,
    LoggingLevelSchema,
    mergeCapabilities,
    missingClientCapabilities,
    MissingRequiredClientCapabilityError,
    modernProtocolVersions,
    parseSchema,
    Protocol,
    ProtocolError,
    ProtocolErrorCode,
    requiredClientCapabilitiesForInputRequest,
    SdkError,
    SdkErrorCode
} from '@modelcontextprotocol/core-internal';
import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/server/_shims';

/**
 * The request methods whose 2026-07-28 result vocabulary includes
 * `input_required` (the multi round-trip methods). Returning an
 * input-required result from any other handler is a server bug.
 */
const INPUT_REQUIRED_CAPABLE_METHODS: ReadonlySet<string> = new Set(['tools/call', 'prompts/get', 'resources/read']);

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
     * Cache hints for the cacheable results of the 2026-07-28 protocol
     * revision (`ttlMs` / `cacheScope`), keyed by operation. The cacheable
     * operations are `tools/list`, `prompts/list`, `resources/list`,
     * `resources/templates/list`, `resources/read` and `server/discover`. The
     * hint is used when the result for that operation does not provide its own
     * cache fields — most useful for the list results and `server/discover`,
     * which the SDK builds itself. A hint registered with an individual
     * resource (`registerResource(..., { cacheHint })`) takes precedence for
     * that resource's `resources/read` results, field by field: a field the
     * per-resource hint leaves unset still falls back to the per-operation
     * hint configured here.
     *
     * Absent hints (or omitting this option entirely) keep today's behavior:
     * cacheable 2026-07-28 results are emitted with `ttlMs: 0` and
     * `cacheScope: 'private'`. Responses to 2025-era requests are never
     * affected. Invalid values throw a `RangeError` at construction time.
     */
    cacheHints?: Partial<Record<CacheableResultMethod, CacheHint>>;

    /**
     * Multi-round-trip `requestState` integrity hook (protocol revision
     * 2026-07-28).
     */
    requestState?: {
        /**
         * Called on every re-entered multi-round-trip request that carries a
         * `requestState` (i.e. whenever `ctx.mcpReq.requestState` is present),
         * BEFORE the handler runs. Throw or reject to refuse the request: the
         * seam answers with a wire-level `-32602` Invalid Params error whose
         * message is frozen to `"Invalid or expired requestState"` and whose
         * `data.reason` is `'invalid_request_state'` — the thrown reason is
         * surfaced via the server's `onerror` callback only and never reaches
         * the wire.
         *
         * This is the place to put HMAC or AEAD verification of
         * `requestState`. The spec MUST for integrity-protecting state that
         * influences authorization, resource access, or business logic is on
         * the server author (basic/patterns/mrtr, server requirements 4–5);
         * the SDK provides NO default verification —
         * {@linkcode server/requestStateCodec.createRequestStateCodec | createRequestStateCodec}
         * is the SDK-provided HMAC helper whose `verify` drops in here
         * directly. Leaving this option
         * unconfigured keeps today's behavior — `ctx.mcpReq.requestState` is
         * passed through raw and MUST be treated as attacker-controlled
         * input.
         *
         * The return value is ignored (the seam awaits-and-discards); the
         * hook signature accepts any return so a verifier that also yields
         * the decoded payload — as
         * {@linkcode server/requestStateCodec.RequestStateCodec | RequestStateCodec}`.verify`
         * does — is directly assignable.
         */
        verify?: (state: string, ctx: ServerContext) => unknown | Promise<unknown>;
    };
};

/*
 * Package-internal hooks for the 2026-07-28 serving entries (the per-request
 * HTTP entry `createMcpHandler` and the connection-pinned stdio entry
 * `serveStdio`).
 *
 * The connection-scoped client-identity fields and the modern-only handler set are
 * private to `Server`; the serving entries in this package need to write/install
 * them on the fresh instance they get from a consumer factory. The static initializer
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
    private _cacheHints?: ServerOptions['cacheHints'];
    private _requestStateVerify?: (state: string, ctx: ServerContext) => unknown | Promise<unknown>;

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
        this._requestStateVerify = options?.requestState?.verify;

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

        // server/discover is installed only when the supported-versions list
        // carries a modern revision: a legacy-only server keeps answering -32601.
        // A hand-constructed instance is never era-bound, so the handler stays
        // unreachable behind the era gate until a serving entry (createMcpHandler,
        // serveStdio) marks the instance as serving the 2026-07-28 era.
        if (modernProtocolVersions(this._supportedProtocolVersions).length > 0) {
            this.setRequestHandler('server/discover', () => this._ondiscover());
        }

        if (this._capabilities.logging) {
            this._registerLoggingHandler();
        }
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

    protected override buildContext(ctx: BaseContext, transportInfo?: MessageExtraInfo): ServerContext {
        // Only create http when there's actual HTTP transport info or auth info
        const hasHttpInfo = ctx.http || transportInfo?.request || transportInfo?.closeSSEStream || transportInfo?.closeStandaloneSSEStream;
        return {
            ...ctx,
            mcpReq: {
                ...ctx.mcpReq,
                // Deprecated as of protocol version 2026-07-28 (SEP-2577): `log` and
                // `requestSampling` remain functional during the deprecation window
                // (at least twelve months). See ServerContext for migration guidance.
                log: (level, data, logger) => {
                    if (!this._capabilities.logging) {
                        return Promise.resolve();
                    }
                    // Level filter: on a 2026-era request the client declares its
                    // threshold per request via the `_meta.logLevel` envelope key
                    // (the modern equivalent of `logging/setLevel`, which is not a
                    // request method on that revision). The spec at 2026-07-28
                    // says an absent key means the server MUST NOT send
                    // `notifications/message` for the request — so an absent key
                    // suppresses, it does not mean "send everything". On
                    // 2025-era connections the session-scoped level set via
                    // `logging/setLevel` applies exactly as before (an absent
                    // session level there continues to mean no filter).
                    let threshold: LoggingLevel | undefined;
                    if (this._servedModernEra()) {
                        threshold = ctx.mcpReq.envelope?.[LOG_LEVEL_META_KEY] as LoggingLevel | undefined;
                        if (threshold === undefined) {
                            return Promise.resolve();
                        }
                    } else {
                        threshold = this._loggingLevels.get(ctx.sessionId) ?? this._loggingLevels.get(undefined);
                    }
                    if (threshold !== undefined && this.LOG_LEVEL_SEVERITY.get(level)! < this.LOG_LEVEL_SEVERITY.get(threshold)!) {
                        return Promise.resolve();
                    }
                    // Emit request-related (like progress and `ctx.mcpReq.notify`)
                    // so the notification rides the in-flight exchange. Without the
                    // related-request stamp, per-request hosting (`createMcpHandler`,
                    // either era) silently drops the message because it has no
                    // session-wide stream to deliver it on.
                    return ctx.mcpReq.notify({ method: 'notifications/message', params: { level, data, logger } });
                },
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
     * handler was registered, attaches the configured per-operation cache hint
     * (when one exists) so the 2026-07-28 encode seam can fill `ttlMs`/`cacheScope`
     * for results that do not provide their own, and owns the multi-round-trip
     * seam: on the methods whose 2026-07-28 result vocabulary includes
     * `input_required` (`tools/call`, `prompts/get`, `resources/read`) an
     * input-required return skips result-schema validation and is checked
     * against the served era, the at-least-one rule, and the request's own
     * declared client capabilities; on every other method an input-required
     * return is a server bug and fails loudly. The hint rides a symbol-keyed
     * property that is never serialized, so 2025-era responses are unaffected.
     */
    protected override _wrapHandler(
        method: string,
        handler: (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result>
    ): (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result> {
        if (method !== 'tools/call') {
            const cacheHint = (this._cacheHints as Record<string, CacheHint | undefined> | undefined)?.[method];
            const isInputRequiredCapable = INPUT_REQUIRED_CAPABLE_METHODS.has(method);
            if (cacheHint === undefined && !isInputRequiredCapable) {
                // Server-bug guard: an input-required return from a method
                // whose result vocabulary does not include it is never
                // mis-typed onto the wire.
                return async (request, ctx) => {
                    const result = await handler(request, ctx);
                    if (isInputRequiredResult(result)) {
                        throw new ProtocolError(
                            ProtocolErrorCode.InternalError,
                            `Handler for ${method} returned an input-required result, but only tools/call, prompts/get and ` +
                                `resources/read support input_required (protocol revision 2026-07-28)`
                        );
                    }
                    return result;
                };
            }
            return async (request, ctx) => {
                const result = isInputRequiredCapable
                    ? await this._invokeInputRequiredCapableHandler(method, handler, request, ctx)
                    : await handler(request, ctx);
                if (isInputRequiredResult(result)) {
                    if (!isInputRequiredCapable) {
                        throw new ProtocolError(
                            ProtocolErrorCode.InternalError,
                            `Handler for ${method} returned an input-required result, but only tools/call, prompts/get and ` +
                                `resources/read support input_required (protocol revision 2026-07-28)`
                        );
                    }
                    // Never cache-stamped (the encode contract skips
                    // non-complete results); the hint is not attached.
                    return result;
                }
                return cacheHint === undefined ? result : attachCacheHintFallback(result, cacheHint);
            };
        }
        return async (request, ctx) => {
            // Era-exact validation via the function-only WireCodec contract:
            // resolved from the instance era at dispatch time (the era gate
            // guarantees tools/call exists on the serving era, so the
            // `not-in-era` arm is an internal error). The era registry entry
            // IS the plain CallToolResult schema (the result map is aligned
            // to the typed map — no widened unions), so no narrower surface
            // is needed.
            const codec = codecForVersion(this._negotiatedProtocolVersion);
            const validatedRequest = codec.validateRequest('tools/call', request);
            if (!validatedRequest.ok) {
                throw new ProtocolError(
                    validatedRequest.reason === 'not-in-era' ? ProtocolErrorCode.InternalError : ProtocolErrorCode.InvalidParams,
                    validatedRequest.reason === 'not-in-era'
                        ? 'No wire schema for tools/call in the resolved era'
                        : `Invalid tools/call request: ${validatedRequest.message}`
                );
            }

            const result = await this._invokeInputRequiredCapableHandler('tools/call', handler, request, ctx);
            if (isInputRequiredResult(result)) {
                // Already checked by the seam; the CallToolResult schema does
                // not apply to it (no widening — InputRequiredResult travels
                // alongside).
                return result;
            }

            const validationResult = codec.validateResult('tools/call', result);
            if (!validationResult.ok) {
                throw new ProtocolError(
                    validationResult.reason === 'not-in-era' ? ProtocolErrorCode.InternalError : ProtocolErrorCode.InvalidParams,
                    validationResult.reason === 'not-in-era'
                        ? 'No wire schema for tools/call in the resolved era'
                        : `Invalid tools/call result: ${validationResult.message}`
                );
            }

            return validationResult.value;
        };
    }

    /**
     * Whether this instance is bound to a 2026-07-28-or-later protocol
     * revision. Era is instance state — a serving entry (`createMcpHandler`,
     * `serveStdio`) marks the instance modern at construction; a 2025-era
     * `initialize` handshake binds it legacy. The multi-round-trip seam reads
     * this directly: there is no per-request era consult.
     */
    private _servedModernEra(): boolean {
        return this._negotiatedProtocolVersion !== undefined && isModernProtocolVersion(this._negotiatedProtocolVersion);
    }

    /**
     * Invokes a handler for one of the multi-round-trip methods and applies
     * the input-required seam:
     *
     * - a `UrlElicitationRequiredError` (or any 2025-style server→client
     *   request idiom) escaping the handler on a request served on the
     *   2026-07-28 era fails LOUDLY with a clear steer to
     *   `inputRequired.elicitUrl(...)` — the `-32042` error never reaches the
     *   2026-07-28 wire and the throw is not silently converted. Requests
     *   served on the 2025 era keep today's `-32042` behavior byte-exact (the
     *   error is rethrown unchanged).
     * - an input-required RETURN is only legal toward the 2026-07-28 era; it
     *   must satisfy the at-least-one rule (`inputRequests` or
     *   `requestState`), and every embedded request must be covered by the
     *   capabilities the client declared on this request's envelope
     *   (violations answer with the typed `-32021` error).
     */
    private async _invokeInputRequiredCapableHandler(
        method: string,
        handler: (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result>,
        request: JSONRPCRequest,
        ctx: ServerContext
    ): Promise<Result> {
        const servedModern = this._servedModernEra();

        // The configured requestState.verify hook runs above the handler (and
        // therefore above the McpServer tools/call funnel), so a rejection
        // reaches the wire as a real JSON-RPC error rather than an `isError`
        // tool result. The wire message is FROZEN — the thrown reason is
        // surfaced via `onerror` only. A non-string `requestState` value (the
        // wire field is `string | undefined`) is treated as invalid regardless
        // of whether a hook is configured, so a malformed value cannot bypass
        // verification.
        const rawRequestState = ctx.mcpReq.requestState as unknown;
        if (rawRequestState !== undefined && typeof rawRequestState !== 'string') {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid or expired requestState', {
                reason: 'invalid_request_state'
            });
        }
        if (this._requestStateVerify !== undefined && typeof rawRequestState === 'string') {
            try {
                await this._requestStateVerify(rawRequestState, ctx);
            } catch (error) {
                this.onerror?.(
                    new Error(`requestState verification rejected ${method}: ${error instanceof Error ? error.message : String(error)}`)
                );
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid or expired requestState', {
                    reason: 'invalid_request_state'
                });
            }
        }

        let result: Result;
        try {
            result = await handler(request, ctx);
        } catch (error) {
            if (error instanceof ProtocolError && error.code === ProtocolErrorCode.UrlElicitationRequired) {
                if (!servedModern) {
                    // 2025-era behavior is frozen: the error reaches the wire
                    // exactly as it does today.
                    throw error;
                }
                // 2026-era requests do not carry the -32042 surface. A
                // 2025-style throw fails loudly with a clear steer rather than
                // being converted: the handler should return
                // inputRequired.elicitUrl(...) instead.
                throw new ProtocolError(
                    ProtocolErrorCode.InternalError,
                    `URL elicitation cannot be signalled by throwing UrlElicitationRequiredError on protocol revision ` +
                        `${this._negotiatedProtocolVersion}: return inputRequired({ inputRequests: { …: inputRequired.elicitUrl(...) } }) ` +
                        `from the handler instead. The urlElicitationRequired error (-32042) of earlier revisions is not ` +
                        `available on this revision.`
                );
            }
            throw error;
        }

        if (!isInputRequiredResult(result)) {
            return result;
        }

        if (!servedModern) {
            // The 2025-era wire has no input_required vocabulary: fail loudly
            // rather than putting a mis-typed result on the wire. A handler
            // that serves both eras branches on the served era and uses the
            // push-style APIs toward 2025-era requests.
            throw new ProtocolError(
                ProtocolErrorCode.InternalError,
                `Handler for ${method} returned an input-required result, but this request is served on protocol revision ` +
                    `${this._negotiatedProtocolVersion ?? LATEST_PROTOCOL_VERSION}, which has no input_required vocabulary`
            );
        }

        // F7 at-least-one re-check (hand-built results are legal; the rule is
        // re-checked at the seam).
        const inputRequests = result.inputRequests as Record<string, unknown> | null | undefined;
        const hasInputRequests = inputRequests != null && Object.keys(inputRequests).length > 0;
        const hasRequestState = typeof result.requestState === 'string';
        if (!hasInputRequests && !hasRequestState) {
            throw new ProtocolError(
                ProtocolErrorCode.InternalError,
                `Handler for ${method} returned an input-required result with neither inputRequests nor requestState ` +
                    `(every InputRequiredResult must include at least one of the two)`
            );
        }

        // Per-embedded-request capability check against the capabilities the
        // client declared on THIS request's envelope (-32021 on violation).
        if (hasInputRequests) {
            const declared = ctx.mcpReq.envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;
            for (const [key, entry] of Object.entries(inputRequests)) {
                if (entry === null || typeof entry !== 'object' || typeof (entry as { method?: unknown }).method !== 'string') {
                    throw new ProtocolError(
                        ProtocolErrorCode.InternalError,
                        `Handler for ${method} returned an invalid input request '${key}': each inputRequests entry must be an ` +
                            `embedded elicitation/create, sampling/createMessage, or roots/list request`
                    );
                }
                const embedded = entry as { method: string; params?: Record<string, unknown> };
                const required = requiredClientCapabilitiesForInputRequest(embedded);
                if (required === undefined) {
                    throw new ProtocolError(
                        ProtocolErrorCode.InternalError,
                        `Handler for ${method} returned an input request '${key}' of kind '${embedded.method}', which is not an ` +
                            `embedded request the 2026-07-28 revision defines`
                    );
                }
                const missing = missingClientCapabilities(required, declared);
                if (missing !== undefined) {
                    throw new MissingRequiredClientCapabilityError(
                        { requiredCapabilities: missing },
                        `Cannot request input '${key}' (${embedded.method}): the request's client capabilities do not declare ` +
                            `the required capability`
                    );
                }
            }
        }

        return result;
    }

    /**
     * Guard for the push-style server→client request APIs ({@linkcode createMessage},
     * {@linkcode elicitInput}, {@linkcode listRoots}, {@linkcode ping}) on a
     * modern-era instance: the 2026-07-28 revision has no server→client request
     * channel, so the call fails before any wire traffic with a typed error
     * whose message steers to `inputRequired(...)`. The base era gate would
     * also reject it; this guard runs first to carry the steer.
     */
    private _assertPushApiInServedEra(method: string): void {
        if (this._servedModernEra()) {
            throw new SdkError(
                SdkErrorCode.MethodNotSupportedByProtocolVersion,
                `Server-to-client requests are not available on protocol revision ${this._negotiatedProtocolVersion}: ` +
                    `'${method}' cannot be sent while serving a request on that revision. ` +
                    `Return inputRequired({ ... }) from the handler instead — the client fulfils the embedded ` +
                    `requests and retries the original request (multi round-trip requests).`,
                { method, era: '2026-07-28' }
            );
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
        this._negotiatedProtocolVersion = protocolVersion;
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
     * 2026-07-28 era report that revision.
     */
    getNegotiatedProtocolVersion(): string | undefined {
        return this._negotiatedProtocolVersion;
    }

    /**
     * Project a `tools/call` result through this instance's negotiated wire
     * codec — the era-agnostic SEP-2106 §4.3 TextContent auto-append, plus on
     * the 2025 era the `{result:…}` wrap when `structuredContent` is a
     * non-object value or the advertised `outputSchema` had a non-object root.
     * Identity for object-shaped `structuredContent` on the 2026 era.
     *
     * `McpServer`'s built-in `tools/call` handler routes through this method.
     * Low-level `setRequestHandler('tools/call', …)` authors call it
     * themselves so the projection lives in one place (the codec) and the
     * server-side handler stays era-blind.
     *
     * This is the only codec function exposed on `Server` — the full
     * `WireCodec` is intentionally not part of the public surface.
     */
    public projectCallToolResult(
        result: CallToolResult,
        advertisedOutputSchema: Readonly<Record<string, unknown>> | undefined
    ): CallToolResult {
        return this._wireCodec().projectCallToolResult(result, advertisedOutputSchema);
    }

    /**
     * Returns the current server capabilities.
     */
    public getCapabilities(): ServerCapabilities {
        return this._capabilities;
    }

    /**
     * Sends a `ping` request to the connected client.
     *
     * @deprecated The 2026-07-28 protocol removed ping; it throws on a 2026-07-28-era instance.
     * If your factory serves both eras, this only works on the legacy path.
     */
    async ping(): Promise<EmptyResult> {
        this._assertPushApiInServedEra('ping');
        return this.request({ method: 'ping' });
    }

    /**
     * Request LLM sampling from the client (without tools).
     * Returns single content block for backwards compatibility.
     *
     * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
     * Throws on a 2026-07-28-era request — use {@link index.inputRequired | inputRequired} (multi-round-trip) instead,
     * or migrate to calling LLM provider APIs directly. The 2025 push-style server-to-client
     * request model is replaced by input_required results in the 2026-07-28 protocol. If your
     * factory serves both eras, this only works on the legacy path.
     */
    async createMessage(params: CreateMessageRequestParamsBase, options?: RequestOptions): Promise<CreateMessageResult>;

    /**
     * Request LLM sampling from the client with tool support.
     * Returns content that may be a single block or array (for parallel tool calls).
     *
     * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
     * Throws on a 2026-07-28-era request — use {@link index.inputRequired | inputRequired} (multi-round-trip) instead,
     * or migrate to calling LLM provider APIs directly. The 2025 push-style server-to-client
     * request model is replaced by input_required results in the 2026-07-28 protocol. If your
     * factory serves both eras, this only works on the legacy path.
     */
    async createMessage(params: CreateMessageRequestParamsWithTools, options?: RequestOptions): Promise<CreateMessageResultWithTools>;

    /**
     * Request LLM sampling from the client.
     * When tools may or may not be present, returns the union type.
     *
     * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
     * Throws on a 2026-07-28-era request — use {@link index.inputRequired | inputRequired} (multi-round-trip) instead,
     * or migrate to calling LLM provider APIs directly. The 2025 push-style server-to-client
     * request model is replaced by input_required results in the 2026-07-28 protocol. If your
     * factory serves both eras, this only works on the legacy path.
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
        this._assertPushApiInServedEra('sampling/createMessage');
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

        // The result schema depends on the REQUEST params (tools vs no tools),
        // which a method-keyed registry entry cannot express — the era codec's
        // `samplingResultVariant` owns the with-tools/plain pair. The funnel's
        // registry-result path runs first (era-gated: sampling/createMessage
        // is not a wire request on the 2026 era, so a modern-era instance
        // fails with the typed era error before anything reaches the
        // transport), then the variant validator narrows the wide result.
        const hasTools = Boolean(params.tools || params.toolChoice);
        const wide = await this.request({ method: 'sampling/createMessage', params }, options);
        const outcome = this._wireCodec().samplingResultVariant(hasTools, wide);
        if (!outcome.ok) {
            // `not-in-era` is unreachable on the path that gets here (the era
            // gate above filters out 2026 instances); `invalid` is a peer bug.
            throw new SdkError(
                SdkErrorCode.InvalidResult,
                `Invalid sampling/createMessage result: ${outcome.reason === 'invalid' ? outcome.message : outcome.reason}`
            );
        }
        return outcome.value;
    }

    /**
     * Creates an elicitation request for the given parameters.
     * For backwards compatibility, `mode` may be omitted for form requests and will default to `"form"`.
     * @param params The parameters for the elicitation request.
     * @param options Optional request options.
     * @returns The result of the elicitation request.
     *
     * @deprecated Throws on a 2026-07-28-era request — use {@link index.inputRequired | inputRequired} (multi-round-trip)
     * instead. The 2025 push-style server-to-client request model is replaced by input_required
     * results in the 2026-07-28 protocol. If your factory serves both eras, this only works on the
     * legacy path.
     */
    async elicitInput(params: ElicitRequestFormParams | ElicitRequestURLParams, options?: RequestOptions): Promise<ElicitResult> {
        this._assertPushApiInServedEra('elicitation/create');
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
     * The notification (and the `elicitationId` it references) exists only on protocol revision
     * 2025-11-25 — the 2026-07-28 draft removed both. On a connection negotiated at 2026-07-28 the
     * returned callback rejects with a typed local error before anything reaches the transport
     * (the method is not part of that revision's wire registry).
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
     * Throws on a 2026-07-28-era request — use {@link index.inputRequired | inputRequired} (multi-round-trip) instead,
     * or migrate to passing paths via tool parameters, resource URIs, or configuration. The 2025
     * push-style server-to-client request model is replaced by input_required results in the
     * 2026-07-28 protocol. If your factory serves both eras, this only works on the legacy path.
     */
    async listRoots(params?: ListRootsRequest['params'], options?: RequestOptions): Promise<ListRootsResult> {
        this._assertPushApiInServedEra('roots/list');
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
 * The capability set a server advertises on `server/discover`. Pure — never
 * mutates the input; the legacy `initialize` advertisement is untouched.
 *
 * The serving entries serve `subscriptions/listen` themselves, so the
 * `listChanged` and `resources.subscribe` capability bits are advertised
 * as-is: a modern-era client uses them to decide which notification types to
 * request on its listen filter.
 */
export function discoverAdvertisedCapabilities(capabilities: ServerCapabilities): ServerCapabilities {
    return { ...capabilities };
}
