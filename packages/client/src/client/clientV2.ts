import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/client/_shims';
import type {
    CallToolRequest,
    ClientCapabilities,
    ClientContext,
    CompleteRequest,
    GetPromptRequest,
    Implementation,
    JSONRPCNotification,
    JSONRPCRequest,
    JsonSchemaType,
    JsonSchemaValidator,
    jsonSchemaValidator,
    ListChangedHandlers,
    ListPromptsRequest,
    ListResourcesRequest,
    ListResourceTemplatesRequest,
    ListToolsRequest,
    LoggingLevel,
    Notification,
    NotificationMethod,
    ReadResourceRequest,
    Request,
    RequestMethod,
    RequestOptions,
    RequestTypeMap,
    Result,
    ResultTypeMap,
    ServerCapabilities,
    SubscribeRequest,
    Tool,
    Transport,
    UnsubscribeRequest
} from '@modelcontextprotocol/core';
import {
    CallToolResultSchema,
    CompleteResultSchema,
    EmptyResultSchema,
    GetPromptResultSchema,
    InitializeResultSchema,
    LATEST_PROTOCOL_VERSION,
    ListPromptsResultSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesResultSchema,
    ListToolsResultSchema,
    mergeCapabilities,
    ReadResourceResultSchema,
    parseSchema,
    ProtocolError,
    ProtocolErrorCode,
    SdkError,
    SdkErrorCode,
    SUPPORTED_PROTOCOL_VERSIONS
} from '@modelcontextprotocol/core';

// TODO(ts-rebuild): replace with `from '@modelcontextprotocol/core'` once the core barrel exports Dispatcher.
import { Dispatcher } from '@modelcontextprotocol/core';

import type { AnySchema, SchemaOutput } from '@modelcontextprotocol/core';
import type { ClientFetchOptions, ClientTransport } from './clientTransport.js';
import { isJSONRPCErrorResponse, isPipeTransport, pipeAsClientTransport } from './clientTransport.js';

/**
 * Loose envelope for the (draft) 2026-06 MRTR `input_required` result. Typed
 * minimally so this compiles before the spec types land; runtime detection is
 * by shape.
 */
type InputRequiredEnvelope = {
    ResultType: 'input_required';
    InputRequests: Record<string, { method: RequestMethod; params?: Record<string, unknown> }>;
};
function isInputRequired(r: unknown): r is InputRequiredEnvelope {
    return (
        typeof r === 'object' &&
        r !== null &&
        (r as { ResultType?: unknown }).ResultType === 'input_required' &&
        typeof (r as { InputRequests?: unknown }).InputRequests === 'object'
    );
}

const MRTR_INPUT_RESPONSES_META_KEY = 'modelcontextprotocol.io/mrtr/inputResponses';
const DEFAULT_MRTR_MAX_ROUNDS = 16;

export type ClientOptions = {
    /** Capabilities to advertise to the server. */
    capabilities?: ClientCapabilities;
    /** Validator for tool `outputSchema`. Defaults to the runtime-appropriate Ajv/CF validator. */
    jsonSchemaValidator?: jsonSchemaValidator;
    /** Handlers for `notifications/*_list_changed`. */
    listChanged?: ListChangedHandlers;
    /** Protocol versions this client supports. First entry is preferred. */
    supportedProtocolVersions?: string[];
    /**
     * If true, list* methods throw on missing server capability instead of
     * returning empty. Default false.
     */
    enforceStrictCapabilities?: boolean;
    /**
     * Upper bound on MRTR rounds for one logical request before throwing
     * {@linkcode SdkErrorCode.InternalError}. Default 16.
     */
    mrtrMaxRounds?: number;
};

/**
 * MCP client built on a request-shaped {@linkcode ClientTransport}.
 *
 * - 2026-06-native: every request is independent; `request()` runs the MRTR
 *   loop, servicing `input_required` rounds via locally registered handlers.
 * - 2025-11-compat: {@linkcode connect} accepts the legacy pipe-shaped
 *   {@linkcode Transport} and runs the initialize handshake.
 */
export class Client {
    private _ct?: ClientTransport;
    private _localDispatcher: Dispatcher<ClientContext> = new Dispatcher();
    private _capabilities: ClientCapabilities;
    private _serverCapabilities?: ServerCapabilities;
    private _serverVersion?: Implementation;
    private _instructions?: string;
    private _negotiatedProtocolVersion?: string;
    private _supportedProtocolVersions: string[];
    private _enforceStrictCapabilities: boolean;
    private _mrtrMaxRounds: number;
    private _jsonSchemaValidator: jsonSchemaValidator;
    private _cachedToolOutputValidators: Map<string, JsonSchemaValidator<unknown>> = new Map();
    private _cachedKnownTaskTools: Set<string> = new Set();
    private _cachedRequiredTaskTools: Set<string> = new Set();
    private _requestMessageId = 0;
    private _pendingListChangedConfig?: ListChangedHandlers;

    onclose?: () => void;
    onerror?: (error: Error) => void;

    constructor(
        private _clientInfo: Implementation,
        options?: ClientOptions
    ) {
        this._capabilities = options?.capabilities ? { ...options.capabilities } : {};
        this._jsonSchemaValidator = options?.jsonSchemaValidator ?? new DefaultJsonSchemaValidator();
        this._supportedProtocolVersions = options?.supportedProtocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS;
        this._enforceStrictCapabilities = options?.enforceStrictCapabilities ?? false;
        this._mrtrMaxRounds = options?.mrtrMaxRounds ?? DEFAULT_MRTR_MAX_ROUNDS;
        this._pendingListChangedConfig = options?.listChanged;
        this._localDispatcher.setRequestHandler('ping', async () => ({}));
    }

    /**
     * Connects to a server. Accepts either a {@linkcode ClientTransport}
     * (2026-06-native, request-shaped) or a legacy pipe {@linkcode Transport}
     * (stdio, SSE, the v1 SHTTP class). Pipe transports are adapted via
     * {@linkcode pipeAsClientTransport} and the 2025-11 initialize handshake
     * is performed.
     */
    async connect(transport: Transport | ClientTransport, options?: RequestOptions): Promise<void> {
        if (isPipeTransport(transport)) {
            this._ct = pipeAsClientTransport(transport, this._localDispatcher);
            this._ct.driver!.onclose = () => this.onclose?.();
            this._ct.driver!.onerror = e => this.onerror?.(e);
            const skipInit = transport.sessionId !== undefined;
            if (skipInit) {
                if (this._negotiatedProtocolVersion && transport.setProtocolVersion) {
                    transport.setProtocolVersion(this._negotiatedProtocolVersion);
                }
                return;
            }
            try {
                await this._initializeHandshake(options, v => transport.setProtocolVersion?.(v));
            } catch (error) {
                void this.close();
                throw error;
            }
            return;
        }
        this._ct = transport;
        try {
            await this._discoverOrInitialize(options);
        } catch (error) {
            void this.close();
            throw error;
        }
    }

    async close(): Promise<void> {
        const ct = this._ct;
        this._ct = undefined;
        await ct?.close();
        this.onclose?.();
    }

    get transport(): Transport | undefined {
        return this._ct?.driver?.pipe;
    }

    /** Register additional capabilities. Must be called before {@linkcode connect}. */
    registerCapabilities(capabilities: ClientCapabilities): void {
        if (this._ct) throw new Error('Cannot register capabilities after connecting to transport');
        this._capabilities = mergeCapabilities(this._capabilities, capabilities);
    }

    getServerCapabilities(): ServerCapabilities | undefined {
        return this._serverCapabilities;
    }
    getServerVersion(): Implementation | undefined {
        return this._serverVersion;
    }
    getNegotiatedProtocolVersion(): string | undefined {
        return this._negotiatedProtocolVersion;
    }
    getInstructions(): string | undefined {
        return this._instructions;
    }

    /**
     * Register a handler for server-initiated requests (sampling, elicitation,
     * roots, ping). In MRTR mode these handlers service `input_required` rounds.
     * In pipe mode they are dispatched directly by the {@linkcode StreamDriver}.
     */
    setRequestHandler<M extends RequestMethod>(
        method: M,
        handler: (request: RequestTypeMap[M], ctx: ClientContext) => ResultTypeMap[M] | Promise<ResultTypeMap[M]>
    ): void {
        this._localDispatcher.setRequestHandler(method, handler);
    }
    removeRequestHandler(method: string): void {
        this._localDispatcher.removeRequestHandler(method);
    }
    setNotificationHandler<M extends NotificationMethod>(method: M, handler: (n: Notification) => void | Promise<void>): void {
        this._localDispatcher.setNotificationHandler(method, handler as never);
    }
    removeNotificationHandler(method: string): void {
        this._localDispatcher.removeNotificationHandler(method);
    }
    set fallbackNotificationHandler(h: ((n: Notification) => Promise<void>) | undefined) {
        this._localDispatcher.fallbackNotificationHandler = h;
    }

    /** Low-level: send one typed request. Runs the MRTR loop. */
    async request<M extends RequestMethod>(req: { method: M; params?: RequestTypeMap[M]['params'] }, options?: RequestOptions) {
        const schema = (await import('@modelcontextprotocol/core')).getResultSchema(req.method);
        return this._request({ method: req.method, params: req.params }, schema, options) as Promise<ResultTypeMap[M]>;
    }

    /** Low-level: send a notification to the server. */
    async notification(n: Notification): Promise<void> {
        if (!this._ct) throw new SdkError(SdkErrorCode.NotConnected, 'Not connected');
        await this._ct.notify(n);
    }

    // -- typed RPC sugar (ported from client.ts) ------------------------------

    async ping(options?: RequestOptions) {
        return this._request({ method: 'ping' }, EmptyResultSchema, options);
    }
    async complete(params: CompleteRequest['params'], options?: RequestOptions) {
        return this._request({ method: 'completion/complete', params }, CompleteResultSchema, options);
    }
    async setLoggingLevel(level: LoggingLevel, options?: RequestOptions) {
        return this._request({ method: 'logging/setLevel', params: { level } }, EmptyResultSchema, options);
    }
    async getPrompt(params: GetPromptRequest['params'], options?: RequestOptions) {
        return this._request({ method: 'prompts/get', params }, GetPromptResultSchema, options);
    }
    async listPrompts(params?: ListPromptsRequest['params'], options?: RequestOptions) {
        if (!this._serverCapabilities?.prompts && !this._enforceStrictCapabilities) return { prompts: [] };
        return this._request({ method: 'prompts/list', params }, ListPromptsResultSchema, options);
    }
    async listResources(params?: ListResourcesRequest['params'], options?: RequestOptions) {
        if (!this._serverCapabilities?.resources && !this._enforceStrictCapabilities) return { resources: [] };
        return this._request({ method: 'resources/list', params }, ListResourcesResultSchema, options);
    }
    async listResourceTemplates(params?: ListResourceTemplatesRequest['params'], options?: RequestOptions) {
        if (!this._serverCapabilities?.resources && !this._enforceStrictCapabilities) return { resourceTemplates: [] };
        return this._request({ method: 'resources/templates/list', params }, ListResourceTemplatesResultSchema, options);
    }
    async readResource(params: ReadResourceRequest['params'], options?: RequestOptions) {
        return this._request({ method: 'resources/read', params }, ReadResourceResultSchema, options);
    }
    async subscribeResource(params: SubscribeRequest['params'], options?: RequestOptions) {
        return this._request({ method: 'resources/subscribe', params }, EmptyResultSchema, options);
    }
    async unsubscribeResource(params: UnsubscribeRequest['params'], options?: RequestOptions) {
        return this._request({ method: 'resources/unsubscribe', params }, EmptyResultSchema, options);
    }
    async listTools(params?: ListToolsRequest['params'], options?: RequestOptions) {
        if (!this._serverCapabilities?.tools && !this._enforceStrictCapabilities) return { tools: [] };
        const result = await this._request({ method: 'tools/list', params }, ListToolsResultSchema, options);
        this._cacheToolMetadata(result.tools);
        return result;
    }
    async callTool(params: CallToolRequest['params'], options?: RequestOptions) {
        if (this._cachedRequiredTaskTools.has(params.name)) {
            throw new ProtocolError(
                ProtocolErrorCode.InvalidRequest,
                `Tool "${params.name}" requires task-based execution. Use client.experimental.tasks.callToolStream() instead.`
            );
        }
        const result = await this._request({ method: 'tools/call', params }, CallToolResultSchema, options);
        const validator = this._cachedToolOutputValidators.get(params.name);
        if (validator) {
            if (!result.structuredContent && !result.isError) {
                throw new ProtocolError(
                    ProtocolErrorCode.InvalidRequest,
                    `Tool ${params.name} has an output schema but did not return structured content`
                );
            }
            if (result.structuredContent) {
                const v = validator(result.structuredContent);
                if (!v.valid) {
                    throw new ProtocolError(
                        ProtocolErrorCode.InvalidParams,
                        `Structured content does not match the tool's output schema: ${v.errorMessage}`
                    );
                }
            }
        }
        return result;
    }
    async sendRootsListChanged() {
        return this.notification({ method: 'notifications/roots/list_changed' });
    }

    // -- internals -----------------------------------------------------------

    private async _request<T extends AnySchema>(req: Request, resultSchema: T, options?: RequestOptions): Promise<SchemaOutput<T>> {
        if (!this._ct) throw new SdkError(SdkErrorCode.NotConnected, 'Not connected');
        let inputResponses: Record<string, unknown> = {};
        for (let round = 0; round < this._mrtrMaxRounds; round++) {
            const id = this._requestMessageId++;
            const meta = {
                ...(req.params?._meta as Record<string, unknown> | undefined),
                ...(round > 0 ? { [MRTR_INPUT_RESPONSES_META_KEY]: inputResponses } : {})
            };
            const jr: JSONRPCRequest = {
                jsonrpc: '2.0',
                id,
                method: req.method,
                params: req.params || round > 0 ? { ...req.params, _meta: Object.keys(meta).length > 0 ? meta : undefined } : undefined
            };
            const opts: ClientFetchOptions = {
                signal: options?.signal,
                timeout: options?.timeout,
                resetTimeoutOnProgress: options?.resetTimeoutOnProgress,
                maxTotalTimeout: options?.maxTotalTimeout,
                onprogress: options?.onprogress,
                onnotification: n => void this._localDispatcher.dispatchNotification(n).catch(e => this.onerror?.(e))
            };
            const resp = await this._ct.fetch(jr, opts);
            if (isJSONRPCErrorResponse(resp)) {
                throw ProtocolError.fromError(resp.error.code, resp.error.message, resp.error.data);
            }
            const raw = resp.result;
            if (isInputRequired(raw)) {
                inputResponses = { ...inputResponses, ...(await this._serviceInputRequests(raw.InputRequests)) };
                continue;
            }
            const parsed = parseSchema(resultSchema, raw);
            if (!parsed.success) throw parsed.error;
            return parsed.data as SchemaOutput<T>;
        }
        throw new ProtocolError(ProtocolErrorCode.InternalError, `MRTR exceeded ${this._mrtrMaxRounds} rounds for ${req.method}`);
    }

    private async _serviceInputRequests(
        reqs: Record<string, { method: RequestMethod; params?: Record<string, unknown> }>
    ): Promise<Record<string, unknown>> {
        const out: Record<string, unknown> = {};
        for (const [key, ir] of Object.entries(reqs)) {
            const synthetic: JSONRPCRequest = { jsonrpc: '2.0', id: `mrtr:${key}`, method: ir.method, params: ir.params };
            const resp = await this._localDispatcher.dispatchToResponse(synthetic);
            if (isJSONRPCErrorResponse(resp)) {
                throw ProtocolError.fromError(resp.error.code, resp.error.message, resp.error.data);
            }
            out[key] = resp.result;
        }
        return out;
    }

    private async _initializeHandshake(options: RequestOptions | undefined, setProtocolVersion: (v: string) => void): Promise<void> {
        const result = await this._request(
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
        if (!this._supportedProtocolVersions.includes(result.protocolVersion)) {
            throw new Error(`Server's protocol version is not supported: ${result.protocolVersion}`);
        }
        this._serverCapabilities = result.capabilities;
        this._serverVersion = result.serverInfo;
        this._negotiatedProtocolVersion = result.protocolVersion;
        this._instructions = result.instructions;
        setProtocolVersion(result.protocolVersion);
        await this.notification({ method: 'notifications/initialized' });
        if (this._pendingListChangedConfig) {
            this._setupListChangedHandlers(this._pendingListChangedConfig);
            this._pendingListChangedConfig = undefined;
        }
    }

    private async _discoverOrInitialize(options?: RequestOptions): Promise<void> {
        // 2026-06: try server/discover, fall back to initialize. Discover schema
        // is not yet in spec types, so probe and accept the result loosely.
        try {
            const resp = await this._ct!.fetch(
                { jsonrpc: '2.0', id: this._requestMessageId++, method: 'server/discover' as RequestMethod },
                { timeout: options?.timeout, signal: options?.signal }
            );
            if (!isJSONRPCErrorResponse(resp)) {
                const r = resp.result as { capabilities?: ServerCapabilities; serverInfo?: Implementation; instructions?: string };
                this._serverCapabilities = r.capabilities;
                this._serverVersion = r.serverInfo;
                this._instructions = r.instructions;
                return;
            }
            if (resp.error.code !== ProtocolErrorCode.MethodNotFound) {
                throw ProtocolError.fromError(resp.error.code, resp.error.message, resp.error.data);
            }
        } catch (error) {
            if (!(error instanceof ProtocolError) || (error as ProtocolError).code !== ProtocolErrorCode.MethodNotFound) {
                // Non-method-not-found error from discover: surface it.
                if (error instanceof ProtocolError) throw error;
            }
        }
        await this._initializeHandshake(options, () => {});
    }

    private _cacheToolMetadata(tools: Tool[]): void {
        this._cachedToolOutputValidators.clear();
        this._cachedKnownTaskTools.clear();
        this._cachedRequiredTaskTools.clear();
        for (const tool of tools) {
            if (tool.outputSchema) {
                this._cachedToolOutputValidators.set(tool.name, this._jsonSchemaValidator.getValidator(tool.outputSchema as JsonSchemaType));
            }
            const ts = tool.execution?.taskSupport;
            if (ts === 'required' || ts === 'optional') this._cachedKnownTaskTools.add(tool.name);
            if (ts === 'required') this._cachedRequiredTaskTools.add(tool.name);
        }
    }

    private _setupListChangedHandlers(config: ListChangedHandlers): void {
        const wire = <T>(kind: 'tools' | 'prompts' | 'resources', notif: NotificationMethod, fetch: () => Promise<T[]>) => {
            const c = config[kind];
            if (!c) return;
            const cap = this._serverCapabilities?.[kind] as { listChanged?: boolean } | undefined;
            if (!cap?.listChanged) return;
            this._localDispatcher.setNotificationHandler(notif, async () => {
                if (c.autoRefresh === false) return c.onChanged(null, null);
                try {
                    c.onChanged(null, (await fetch()) as never);
                } catch (e) {
                    c.onChanged(e instanceof Error ? e : new Error(String(e)), null);
                }
            });
        };
        wire('tools', 'notifications/tools/list_changed', async () => (await this.listTools()).tools);
        wire('prompts', 'notifications/prompts/list_changed', async () => (await this.listPrompts()).prompts ?? []);
        wire('resources', 'notifications/resources/list_changed', async () => (await this.listResources()).resources ?? []);
    }
}

export type { ClientTransport, ClientFetchOptions } from './clientTransport.js';
export { pipeAsClientTransport, isPipeTransport } from './clientTransport.js';
