import type {
    CallToolRequest,
    CallToolResult,
    ClientCapabilities,
    ClientContext,
    CompleteRequest,
    CompleteResult,
    GetPromptRequest,
    GetPromptResult,
    HandlerRegistry,
    Implementation,
    JSONRPCMessage,
    JSONRPCNotification,
    JSONRPCRequest,
    ListPromptsRequest,
    ListPromptsResult,
    ListResourcesRequest,
    ListResourcesResult,
    ListResourceTemplatesRequest,
    ListResourceTemplatesResult,
    ListToolsRequest,
    ListToolsResult,
    LoggingLevel,
    ReadResourceRequest,
    ReadResourceResult,
    RequestOptions,
    Result,
    ServerCapabilities,
    SubscribeRequest,
    Transport,
    UnsubscribeRequest
} from '@modelcontextprotocol/core';
import {
    DEFAULT_REQUEST_TIMEOUT_MSEC,
    isJSONRPCErrorResponse,
    isJSONRPCNotification,
    isJSONRPCRequest,
    isJSONRPCResultResponse,
    ProtocolError,
    SdkError,
    SdkErrorCode
} from '@modelcontextprotocol/core';

/**
 * The result returned by the `server/discover` endpoint on modern (2026-06) servers.
 */
export interface DiscoverResult {
    supportedVersions: string[];
    capabilities: ServerCapabilities;
    serverInfo: Implementation;
    instructions?: string;
}

/**
 * Pending request entry in the correlator map.
 */
interface PendingRequest {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * A lightweight MCP client for the modern (2026-06) protocol.
 *
 * Unlike {@linkcode import('./client.js').LegacyClient | LegacyClient}, this class does NOT extend Protocol.
 * It manages its own request/response correlation, injects `_meta` with protocol
 * version and client info into every request, and delegates HTTP-level concerns
 * (like the `Mcp-Method` header) to the transport layer.
 *
 * Server state (capabilities, version, instructions) is populated from a
 * {@linkcode DiscoverResult} passed to the constructor rather than from an
 * initialize handshake.
 */
export class ModernClientImpl {
    private _transport?: Transport;
    private _nextId = 0;
    private _pending: Map<number, PendingRequest> = new Map();
    private _clientInfo: Implementation;
    private _clientCapabilities: ClientCapabilities;
    private _serverCapabilities: ServerCapabilities;
    private _serverVersion: Implementation;
    private _instructions?: string;
    private _registry: HandlerRegistry<ClientContext, ClientCapabilities>;

    /**
     * Callback for when the connection is closed.
     */
    onclose?: () => void;

    /**
     * Callback for when an error occurs.
     */
    onerror?: (error: Error) => void;

    constructor(
        clientInfo: Implementation,
        clientCapabilities: ClientCapabilities,
        discoverResult: DiscoverResult,
        registry: HandlerRegistry<ClientContext, ClientCapabilities>
    ) {
        this._clientInfo = clientInfo;
        this._clientCapabilities = clientCapabilities;
        this._serverCapabilities = discoverResult.capabilities;
        this._serverVersion = discoverResult.serverInfo;
        this._instructions = discoverResult.instructions;
        this._registry = registry;
    }

    /**
     * Connects to a transport. Wires `transport.onmessage` to dispatch
     * responses, notifications, and server-to-client requests.
     *
     * Unlike the legacy path, no initialize handshake is performed --
     * server state was already obtained via `server/discover`.
     */
    async connect(transport: Transport): Promise<void> {
        this._transport = transport;

        transport.onmessage = (message: JSONRPCMessage) => {
            if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
                this._onResponse(message);
            } else if (isJSONRPCNotification(message)) {
                this._onNotification(message);
            } else if (isJSONRPCRequest(message)) {
                this._onRequest(message);
            }
        };

        transport.onclose = () => {
            this._rejectAll(new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed'));
            this.onclose?.();
        };

        transport.onerror = (error: Error) => {
            this.onerror?.(error);
        };

        // Transport is already started by VersionProbingHTTPClientTransport.start()
    }

    /**
     * Closes the connection and rejects all pending requests.
     */
    async close(): Promise<void> {
        this._rejectAll(new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed'));
        await this._transport?.close();
        this._transport = undefined;
    }

    get transport(): Transport | undefined {
        return this._transport;
    }

    // ---------------------------------------------------------------------------
    // Server state accessors
    // ---------------------------------------------------------------------------

    getServerCapabilities(): ServerCapabilities {
        return this._serverCapabilities;
    }

    getServerVersion(): Implementation {
        return this._serverVersion;
    }

    getInstructions(): string | undefined {
        return this._instructions;
    }

    // ---------------------------------------------------------------------------
    // High-level request methods
    // ---------------------------------------------------------------------------

    async ping(options?: RequestOptions): Promise<Result> {
        return this._request('ping', undefined, options);
    }

    async complete(params: CompleteRequest['params'], options?: RequestOptions): Promise<CompleteResult> {
        this._assertCapability('completions', 'completion/complete');
        return this._request('completion/complete', params, options);
    }

    async setLoggingLevel(level: LoggingLevel, options?: RequestOptions): Promise<Result> {
        this._assertCapability('logging', 'logging/setLevel');
        return this._request('logging/setLevel', { level }, options);
    }

    async getPrompt(params: GetPromptRequest['params'], options?: RequestOptions): Promise<GetPromptResult> {
        this._assertCapability('prompts', 'prompts/get');
        return this._request('prompts/get', params, options);
    }

    async listPrompts(params?: ListPromptsRequest['params'], options?: RequestOptions): Promise<ListPromptsResult> {
        if (!this._serverCapabilities.prompts) {
            return { prompts: [] };
        }
        return this._request('prompts/list', params, options);
    }

    async listResources(params?: ListResourcesRequest['params'], options?: RequestOptions): Promise<ListResourcesResult> {
        if (!this._serverCapabilities.resources) {
            return { resources: [] };
        }
        return this._request('resources/list', params, options);
    }

    async listResourceTemplates(
        params?: ListResourceTemplatesRequest['params'],
        options?: RequestOptions
    ): Promise<ListResourceTemplatesResult> {
        if (!this._serverCapabilities.resources) {
            return { resourceTemplates: [] };
        }
        return this._request('resources/templates/list', params, options);
    }

    async readResource(params: ReadResourceRequest['params'], options?: RequestOptions): Promise<ReadResourceResult> {
        this._assertCapability('resources', 'resources/read');
        return this._request('resources/read', params, options);
    }

    async subscribeResource(params: SubscribeRequest['params'], options?: RequestOptions): Promise<Result> {
        this._assertCapability('resources', 'resources/subscribe');
        if (!this._serverCapabilities.resources?.subscribe) {
            throw new SdkError(
                SdkErrorCode.CapabilityNotSupported,
                'Server does not support resource subscriptions (required for resources/subscribe)'
            );
        }
        return this._request('resources/subscribe', params, options);
    }

    async unsubscribeResource(params: UnsubscribeRequest['params'], options?: RequestOptions): Promise<Result> {
        this._assertCapability('resources', 'resources/unsubscribe');
        return this._request('resources/unsubscribe', params, options);
    }

    async callTool(params: CallToolRequest['params'], options?: RequestOptions): Promise<CallToolResult> {
        this._assertCapability('tools', 'tools/call');
        return this._request('tools/call', params, options);
    }

    async listTools(params?: ListToolsRequest['params'], options?: RequestOptions): Promise<ListToolsResult> {
        if (!this._serverCapabilities.tools) {
            return { tools: [] };
        }
        return this._request('tools/list', params, options);
    }

    // ---------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------

    private _assertCapability(capability: keyof ServerCapabilities, method: string): void {
        if (!this._serverCapabilities[capability]) {
            throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support ${capability} (required for ${method})`);
        }
    }

    /**
     * Sends a JSON-RPC request with `_meta` injection containing protocol version,
     * client capabilities, and client info. Returns a promise that resolves when
     * the server responds.
     */
    private _request<T>(method: string, params?: Record<string, unknown>, options?: RequestOptions): Promise<T> {
        const id = this._nextId++;
        const timeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;

        const message: JSONRPCRequest = {
            jsonrpc: '2.0',
            id,
            method,
            params: {
                ...params,
                _meta: {
                    ...(params?._meta as Record<string, unknown> | undefined),
                    protocolVersion: '2026-06-30',
                    clientCapabilities: this._clientCapabilities,
                    clientInfo: this._clientInfo
                }
            }
        };

        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pending.delete(id);
                reject(new SdkError(SdkErrorCode.RequestTimeout, 'Request timed out', { timeout }));
            }, timeout);

            this._pending.set(id, {
                resolve: result => {
                    clearTimeout(timer);
                    resolve(result as T);
                },
                reject: error => {
                    clearTimeout(timer);
                    reject(error);
                },
                timer
            });

            this._transport!.send(message).catch(sendError => {
                clearTimeout(timer);
                this._pending.delete(id);
                reject(sendError);
            });
        });
    }

    /**
     * Dispatches a JSON-RPC response to the matching pending request.
     */
    private _onResponse(response: JSONRPCMessage): void {
        const id = Number((response as { id?: unknown }).id);
        const pending = this._pending.get(id);
        if (!pending) {
            this.onerror?.(new Error(`Received response for unknown request ID: ${id}`));
            return;
        }
        this._pending.delete(id);

        if (isJSONRPCResultResponse(response)) {
            pending.resolve(response.result);
        } else if (isJSONRPCErrorResponse(response)) {
            pending.reject(ProtocolError.fromError(response.error.code, response.error.message, response.error.data));
        }
    }

    /**
     * Dispatches a server-to-client notification to a registered handler.
     */
    private _onNotification(notification: JSONRPCNotification): void {
        const handler = this._registry.notificationHandlers.get(notification.method) ?? this._registry.fallbackNotificationHandler;
        if (handler) {
            Promise.resolve()
                .then(() => handler(notification))
                .catch(error => this.onerror?.(new Error(`Uncaught error in notification handler: ${error}`)));
        }
    }

    /**
     * Dispatches a server-to-client request to a registered handler.
     */
    private _onRequest(request: JSONRPCRequest): void {
        const handler = this._registry.requestHandlers.get(request.method) ?? this._registry.fallbackRequestHandler;
        if (!handler) {
            this._transport
                ?.send({
                    jsonrpc: '2.0',
                    id: request.id,
                    error: { code: -32_601, message: 'Method not found' }
                })
                .catch(error => this.onerror?.(new Error(`Failed to send error response: ${error}`)));
            return;
        }

        const abortController = new AbortController();
        const ctx: ClientContext = {
            mcpReq: {
                id: request.id,
                method: request.method,
                _meta: request.params?._meta as ClientContext['mcpReq']['_meta'],
                signal: abortController.signal,
                send: (() => {
                    throw new Error('Bidirectional requests not supported on modern client path');
                }) as ClientContext['mcpReq']['send'],
                notify: () => {
                    throw new Error('Bidirectional notifications not supported on modern client path');
                }
            }
        };

        Promise.resolve()
            .then(() => handler(request, ctx))
            .then(result => {
                this._transport
                    ?.send({
                        jsonrpc: '2.0',
                        id: request.id,
                        result
                    })
                    .catch(error => this.onerror?.(new Error(`Failed to send response: ${error}`)));
            })
            .catch(error => {
                const errorRecord = error as Record<string, unknown>;
                this._transport
                    ?.send({
                        jsonrpc: '2.0',
                        id: request.id,
                        error: {
                            code: Number.isSafeInteger(errorRecord['code']) ? (errorRecord['code'] as number) : -32_603,
                            message: (error as Error).message ?? 'Internal error'
                        }
                    })
                    .catch(error_ => this.onerror?.(new Error(`Failed to send error response: ${error_}`)));
            });
    }

    /**
     * Rejects all pending requests with the given error.
     */
    private _rejectAll(error: Error): void {
        const pending = this._pending;
        this._pending = new Map();
        for (const entry of pending.values()) {
            entry.reject(error);
        }
    }
}
