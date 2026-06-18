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
    JSONRPCNotification,
    JSONRPCRequest,
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
    NotificationMethod,
    ProtocolOptions,
    ReadResourceRequest,
    ReadResourceResult,
    RequestMethod,
    RequestOptions,
    Result,
    ServerCapabilities,
    SubscribeRequest,
    Tool,
    Transport,
    UnsubscribeRequest
} from '@modelcontextprotocol/core';
import {
    codecForVersion,
    CreateMessageResultSchema,
    CreateMessageResultWithToolsSchema,
    DEFAULT_REQUEST_TIMEOUT_MSEC,
    DiscoverResultSchema,
    isJSONRPCRequest,
    isModernProtocolVersion,
    legacyProtocolVersions,
    ListChangedOptionsBaseSchema,
    mergeCapabilities,
    parseSchema,
    Protocol,
    ProtocolError,
    ProtocolErrorCode,
    SdkError,
    SdkErrorCode
} from '@modelcontextprotocol/core';

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
     * - absent or `mode: 'legacy'` — the plain 2025 connect sequence, byte-identical
     *   to today's behavior (no probe, no new headers).
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
     * Probe policy lives under `probe: { timeoutMs? }`; the probe inherits the
     * client's standard request timeout unless overridden.
     */
    versionNegotiation?: VersionNegotiationOptions;

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
    private _cachedToolOutputValidators: Map<string, JsonSchemaValidator<unknown>> = new Map();
    private _listChangedDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private _pendingListChangedConfig?: ListChangedHandlers;
    private _enforceStrictCapabilities: boolean;
    private _versionNegotiation?: VersionNegotiationOptions;
    private _supportedProtocolVersionsOption?: string[];

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

        // Store list changed config for setup after connection (when we know server capabilities)
        if (options?.listChanged) {
            this._pendingListChangedConfig = options.listChanged;
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
     * regardless of how the handler was registered.
     */
    protected override _wrapHandler(
        method: string,
        handler: (request: JSONRPCRequest, ctx: ClientContext) => Promise<Result>
    ): (request: JSONRPCRequest, ctx: ClientContext) => Promise<Result> {
        if (method === 'elicitation/create') {
            return async (request, ctx) => {
                // Era-exact validation: the schemas are resolved from the
                // instance era at dispatch time (the era gate guarantees the
                // method exists on the serving era before we get here).
                const codec = codecForVersion(this._negotiatedProtocolVersion);
                const elicitRequestSchema = codec.requestSchema('elicitation/create');
                // The era registry entry IS the plain ElicitResult schema
                // (the result map is aligned to the typed map — no widened
                // unions), so no narrower surface is needed.
                const elicitResultSchema = codec.resultSchema('elicitation/create');
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
                // Era-exact validation via the instance era (see above).
                const codec = codecForVersion(this._negotiatedProtocolVersion);
                const samplingRequestSchema = codec.requestSchema('sampling/createMessage');
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

                // The result schema depends on the REQUEST params (tools vs
                // no tools) — something a method-keyed registry entry cannot
                // express, so the pair is picked here. The era gate keeps
                // this era-correct: sampling/createMessage is only ever
                // dispatched on an era whose registry defines it.
                const hasTools = params.tools || params.toolChoice;
                const resultSchema = hasTools ? CreateMessageResultWithToolsSchema : CreateMessageResultSchema;
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
        // Fresh connect: the negotiated protocol version is connection state —
        // a value left over from a previous connection must not survive into a
        // new handshake. Clearing it puts the instance back in the
        // pre-negotiation phase, so the initialize exchange below rides the
        // bootstrap method pins (legacy era) instead of a dead session's era.
        // Without this, an instance that once negotiated a modern era could
        // never re-run a fresh handshake: `initialize` is physically absent
        // from the modern registry. (The resume branch above keeps it instead.)
        this._negotiatedProtocolVersion = undefined;
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
        this._negotiatedProtocolVersion = undefined;

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
        // are configured straight from the advertised capabilities.
        if (this._pendingListChangedConfig) {
            this._setupListChangedHandlers(this._pendingListChangedConfig);
            this._pendingListChangedConfig = undefined;
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
     * Lists available prompts. Results may be paginated — loop on `nextCursor` to collect all pages.
     *
     * Returns an empty list if the server does not advertise prompts capability
     * (or throws if {@linkcode ClientOptions.enforceStrictCapabilities} is enabled).
     *
     * @example
     * ```ts source="./client.examples.ts#Client_listPrompts_pagination"
     * const allPrompts: Prompt[] = [];
     * let cursor: string | undefined;
     * // Note: an empty-string cursor is valid and does not signal the end of results.
     * do {
     *     const { prompts, nextCursor } = await client.listPrompts({ cursor });
     *     allPrompts.push(...prompts);
     *     cursor = nextCursor;
     * } while (cursor !== undefined);
     * console.log(
     *     'Available prompts:',
     *     allPrompts.map(p => p.name)
     * );
     * ```
     */
    async listPrompts(params?: ListPromptsRequest['params'], options?: RequestOptions): Promise<ListPromptsResult> {
        if (!this._serverCapabilities?.prompts && !this._enforceStrictCapabilities) {
            // Respect capability negotiation: server does not support prompts
            console.debug('Client.listPrompts() called but server does not advertise prompts capability - returning empty list');
            return { prompts: [] };
        }
        return this.request({ method: 'prompts/list', params }, options);
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
     * // Note: an empty-string cursor is valid and does not signal the end of results.
     * do {
     *     const { resources, nextCursor } = await client.listResources({ cursor });
     *     allResources.push(...resources);
     *     cursor = nextCursor;
     * } while (cursor !== undefined);
     * console.log(
     *     'Available resources:',
     *     allResources.map(r => r.name)
     * );
     * ```
     */
    async listResources(params?: ListResourcesRequest['params'], options?: RequestOptions): Promise<ListResourcesResult> {
        if (!this._serverCapabilities?.resources && !this._enforceStrictCapabilities) {
            // Respect capability negotiation: server does not support resources
            console.debug('Client.listResources() called but server does not advertise resources capability - returning empty list');
            return { resources: [] };
        }
        return this.request({ method: 'resources/list', params }, options);
    }

    /**
     * Lists available resource URI templates for dynamic resources. Results may be paginated — see {@linkcode listResources | listResources()} for the cursor pattern.
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
        return this.request({ method: 'resources/templates/list', params }, options);
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
    async callTool(params: CallToolRequest['params'], options?: RequestOptions): Promise<CallToolResult> {
        // The method-keyed request() path validates the era registry's plain
        // CallToolResult schema — with the result map aligned to the typed
        // map there is no wider union to narrow away (Q1-SD2 holds by
        // construction).
        const result = await this.request({ method: 'tools/call', params }, options);

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
     * // Note: an empty-string cursor is valid and does not signal the end of results.
     * do {
     *     const { tools, nextCursor } = await client.listTools({ cursor });
     *     allTools.push(...tools);
     *     cursor = nextCursor;
     * } while (cursor !== undefined);
     * console.log(
     *     'Available tools:',
     *     allTools.map(t => t.name)
     * );
     * ```
     */
    async listTools(params?: ListToolsRequest['params'], options?: RequestOptions): Promise<ListToolsResult> {
        if (!this._serverCapabilities?.tools && !this._enforceStrictCapabilities) {
            // Respect capability negotiation: server does not support tools
            console.debug('Client.listTools() called but server does not advertise tools capability - returning empty list');
            return { tools: [] };
        }
        const result = await this.request({ method: 'tools/list', params }, options);

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
     * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
     * Remains functional during the deprecation window (at least twelve months).
     * Migrate to passing paths via tool parameters, resource URIs, or configuration.
     */
    async sendRootsListChanged() {
        return this.notification({ method: 'notifications/roots/list_changed' });
    }
}
