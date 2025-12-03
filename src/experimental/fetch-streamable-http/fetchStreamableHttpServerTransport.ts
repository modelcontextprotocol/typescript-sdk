/**
 * Web Standards Streamable HTTP Server Transport
 *
 * This is an experimental transport that implements the MCP Streamable HTTP specification
 * using Web Standard APIs (Request, Response, TransformStream) instead of Node.js HTTP.
 *
 * @see https://github.com/modelcontextprotocol/typescript-sdk/issues/260
 * @experimental
 */

import { Transport } from '../../shared/transport.js';
import {
    MessageExtraInfo,
    RequestInfo,
    isInitializeRequest,
    isJSONRPCError,
    isJSONRPCRequest,
    isJSONRPCResponse,
    JSONRPCMessage,
    JSONRPCMessageSchema,
    RequestId,
    SUPPORTED_PROTOCOL_VERSIONS,
    DEFAULT_NEGOTIATED_PROTOCOL_VERSION
} from '../../types.js';

export type StreamId = string;
export type EventId = string;

/**
 * Interface for resumability support via event storage
 */
export interface EventStore {
    /**
     * Stores an event for later retrieval
     * @param streamId ID of the stream the event belongs to
     * @param message The JSON-RPC message to store
     * @returns The generated event ID for the stored event
     */
    storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId>;

    /**
     * Get the stream ID associated with a given event ID.
     * @param eventId The event ID to look up
     * @returns The stream ID, or undefined if not found
     *
     * Optional: If not provided, the SDK will use the streamId returned by
     * replayEventsAfter for stream mapping.
     */
    getStreamIdForEventId?(eventId: EventId): Promise<StreamId | undefined>;

    replayEventsAfter(
        lastEventId: EventId,
        {
            send
        }: {
            send: (eventId: EventId, message: JSONRPCMessage) => Promise<void>;
        }
    ): Promise<StreamId>;
}

/**
 * Session state that can be persisted externally for serverless deployments.
 */
export interface SessionState {
    /** Whether the session has completed initialization */
    initialized: boolean;
    /** The negotiated protocol version */
    protocolVersion: string;
    /** Timestamp when the session was created */
    createdAt: number;
}

/**
 * Interface for session storage in distributed/serverless deployments.
 *
 * In serverless environments (Lambda, Vercel, Cloudflare Workers), each request
 * may be handled by a different instance with no shared memory. The SessionStore
 * allows session state to be persisted externally (e.g., Redis, DynamoDB, KV).
 *
 * @example
 * ```typescript
 * // Cloudflare KV implementation
 * class KVSessionStore implements SessionStore {
 *   constructor(private kv: KVNamespace) {}
 *
 *   async get(sessionId: string) {
 *     return this.kv.get(`session:${sessionId}`, 'json');
 *   }
 *   async save(sessionId: string, state: SessionState) {
 *     await this.kv.put(`session:${sessionId}`, JSON.stringify(state), { expirationTtl: 3600 });
 *   }
 *   async delete(sessionId: string) {
 *     await this.kv.delete(`session:${sessionId}`);
 *   }
 * }
 * ```
 */
export interface SessionStore {
    /**
     * Retrieve session state by ID.
     * @param sessionId The session ID to look up
     * @returns The session state, or undefined if not found
     */
    get(sessionId: string): Promise<SessionState | undefined>;

    /**
     * Save session state.
     * Called when a session is initialized or updated.
     * @param sessionId The session ID
     * @param state The session state to persist
     */
    save(sessionId: string, state: SessionState): Promise<void>;

    /**
     * Delete session state.
     * Called when a session is explicitly closed via DELETE request.
     * @param sessionId The session ID to delete
     */
    delete(sessionId: string): Promise<void>;
}

/**
 * Internal stream mapping for managing SSE connections
 */
interface StreamMapping {
    /** Stream controller for pushing SSE data - only used with ReadableStream approach */
    controller?: ReadableStreamDefaultController<Uint8Array>;
    /** Text encoder for SSE formatting */
    encoder?: TextEncoder;
    /** Promise resolver for JSON response mode */
    resolveJson?: (response: Response) => void;
    /** Cleanup function to close stream and remove mapping */
    cleanup: () => void;
}

/**
 * Configuration options for FetchStreamableHTTPServerTransport
 */
export interface FetchStreamableHTTPServerTransportOptions {
    /**
     * Function that generates a session ID for the transport.
     * The session ID SHOULD be globally unique and cryptographically secure (e.g., a securely generated UUID, a JWT, or a cryptographic hash)
     *
     * Return undefined to disable session management.
     */
    sessionIdGenerator: (() => string) | undefined;

    /**
     * A callback for session initialization events
     * This is called when the server initializes a new session.
     * Useful in cases when you need to register multiple mcp sessions
     * and need to keep track of them.
     * @param sessionId The generated session ID
     */
    onsessioninitialized?: (sessionId: string) => void | Promise<void>;

    /**
     * A callback for session close events
     * This is called when the server closes a session due to a DELETE request.
     * Useful in cases when you need to clean up resources associated with the session.
     * Note that this is different from the transport closing, if you are handling
     * HTTP requests from multiple nodes you might want to close each
     * WSStreamableHTTPServerTransport after a request is completed while still keeping the
     * session open/running.
     * @param sessionId The session ID that was closed
     */
    onsessionclosed?: (sessionId: string) => void | Promise<void>;

    /**
     * If true, the server will return JSON responses instead of starting an SSE stream.
     * This can be useful for simple request/response scenarios without streaming.
     * Default is false (SSE streams are preferred).
     */
    enableJsonResponse?: boolean;

    /**
     * Event store for resumability support
     * If provided, resumability will be enabled, allowing clients to reconnect and resume messages
     */
    eventStore?: EventStore;

    /**
     * List of allowed host header values for DNS rebinding protection.
     * If not specified, host validation is disabled.
     */
    allowedHosts?: string[];

    /**
     * List of allowed origin header values for DNS rebinding protection.
     * If not specified, origin validation is disabled.
     */
    allowedOrigins?: string[];

    /**
     * Enable DNS rebinding protection (requires allowedHosts and/or allowedOrigins to be configured).
     * Default is false for backwards compatibility.
     */
    enableDnsRebindingProtection?: boolean;

    /**
     * Retry interval in milliseconds to suggest to clients in SSE retry field.
     * When set, the server will send a retry field in SSE priming events to control
     * client reconnection timing for polling behavior.
     */
    retryInterval?: number;

    /**
     * Session store for distributed/serverless deployments.
     *
     * When provided, session state will be persisted externally, allowing the transport
     * to work across multiple serverless function invocations or instances.
     *
     * If not provided, session state is kept in-memory (single-instance mode).
     *
     * @example
     * ```typescript
     * // Redis session store
     * const transport = new FetchStreamableHTTPServerTransport({
     *   sessionIdGenerator: () => crypto.randomUUID(),
     *   sessionStore: {
     *     get: async (id) => redis.get(`session:${id}`),
     *     save: async (id, state) => redis.set(`session:${id}`, state, 'EX', 3600),
     *     delete: async (id) => redis.del(`session:${id}`)
     *   }
     * });
     * ```
     */
    sessionStore?: SessionStore;
}

/**
 * Server transport for Web Standards Streamable HTTP: this implements the MCP Streamable HTTP transport specification
 * using Web Standard APIs (Request, Response, TransformStream).
 *
 * Usage example:
 *
 * ```typescript
 * // Stateful mode - server sets the session ID
 * const statefulTransport = new FetchStreamableHTTPServerTransport({
 *   sessionIdGenerator: () => crypto.randomUUID(),
 * });
 *
 * // Stateless mode - explicitly set session ID to undefined
 * const statelessTransport = new FetchStreamableHTTPServerTransport({
 *   sessionIdGenerator: undefined,
 * });
 *
 * // Hono.js usage
 * app.all('/mcp', async (c) => {
 *   return transport.handleRequest(c.req.raw);
 * });
 * ```
 *
 * In stateful mode:
 * - Session ID is generated and included in response headers
 * - Session ID is always included in initialization responses
 * - Requests with invalid session IDs are rejected with 404 Not Found
 * - Non-initialization requests without a session ID are rejected with 400 Bad Request
 * - State is maintained in-memory (connections, message history)
 *
 * In stateless mode:
 * - No Session ID is included in any responses
 * - No session validation is performed
 *
 * @experimental
 */
export class FetchStreamableHTTPServerTransport implements Transport {
    // when sessionId is not set (undefined), it means the transport is in stateless mode
    private sessionIdGenerator: (() => string) | undefined;
    private _started: boolean = false;
    private _streamMapping: Map<string, StreamMapping> = new Map();
    private _requestToStreamMapping: Map<RequestId, string> = new Map();
    private _requestResponseMap: Map<RequestId, JSONRPCMessage> = new Map();
    private _initialized: boolean = false;
    private _enableJsonResponse: boolean = false;
    private _standaloneSseStreamId: string = '_GET_stream';
    private _eventStore?: EventStore;
    private _onsessioninitialized?: (sessionId: string) => void | Promise<void>;
    private _onsessionclosed?: (sessionId: string) => void | Promise<void>;
    private _allowedHosts?: string[];
    private _allowedOrigins?: string[];
    private _enableDnsRebindingProtection: boolean;
    private _retryInterval?: number;
    private _sessionStore?: SessionStore;

    sessionId?: string;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

    constructor(options: FetchStreamableHTTPServerTransportOptions) {
        this.sessionIdGenerator = options.sessionIdGenerator;
        this._enableJsonResponse = options.enableJsonResponse ?? false;
        this._eventStore = options.eventStore;
        this._onsessioninitialized = options.onsessioninitialized;
        this._onsessionclosed = options.onsessionclosed;
        this._allowedHosts = options.allowedHosts;
        this._allowedOrigins = options.allowedOrigins;
        this._enableDnsRebindingProtection = options.enableDnsRebindingProtection ?? false;
        this._retryInterval = options.retryInterval;
        this._sessionStore = options.sessionStore;
    }

    /**
     * Starts the transport. This is required by the Transport interface but is a no-op
     * for the Streamable HTTP transport as connections are managed per-request.
     */
    async start(): Promise<void> {
        if (this._started) {
            throw new Error('Transport already started');
        }
        this._started = true;
    }

    /**
     * Helper to create a JSON error response
     */
    private createJsonErrorResponse(status: number, code: number, message: string, headers?: Record<string, string>): Response {
        return new Response(
            JSON.stringify({
                jsonrpc: '2.0',
                error: { code, message },
                id: null
            }),
            {
                status,
                headers: {
                    'Content-Type': 'application/json',
                    ...headers
                }
            }
        );
    }

    /**
     * Validates request headers for DNS rebinding protection.
     * @returns Error response if validation fails, undefined if validation passes.
     */
    private validateRequestHeaders(req: Request): Response | undefined {
        // Skip validation if protection is not enabled
        if (!this._enableDnsRebindingProtection) {
            return undefined;
        }

        // Validate Host header if allowedHosts is configured
        if (this._allowedHosts && this._allowedHosts.length > 0) {
            const hostHeader = req.headers.get('host');
            if (!hostHeader || !this._allowedHosts.includes(hostHeader)) {
                const error = `Invalid Host header: ${hostHeader}`;
                this.onerror?.(new Error(error));
                return this.createJsonErrorResponse(403, -32000, error);
            }
        }

        // Validate Origin header if allowedOrigins is configured
        if (this._allowedOrigins && this._allowedOrigins.length > 0) {
            const originHeader = req.headers.get('origin');
            if (!originHeader || !this._allowedOrigins.includes(originHeader)) {
                const error = `Invalid Origin header: ${originHeader}`;
                this.onerror?.(new Error(error));
                return this.createJsonErrorResponse(403, -32000, error);
            }
        }

        return undefined;
    }

    /**
     * Handles an incoming HTTP request, whether GET, POST, or DELETE
     * Returns a Response object (Web Standard)
     */
    async handleRequest(req: Request): Promise<Response> {
        // Validate request headers for DNS rebinding protection
        const validationError = this.validateRequestHeaders(req);
        if (validationError) {
            return validationError;
        }

        switch (req.method) {
            case 'POST':
                return this.handlePostRequest(req);
            case 'GET':
                return this.handleGetRequest(req);
            case 'DELETE':
                return this.handleDeleteRequest(req);
            default:
                return this.handleUnsupportedRequest();
        }
    }

    /**
     * Writes a priming event to establish resumption capability.
     * Only sends if eventStore is configured (opt-in for resumability).
     */
    private async writePrimingEvent(
        controller: ReadableStreamDefaultController<Uint8Array>,
        encoder: TextEncoder,
        streamId: string
    ): Promise<void> {
        if (!this._eventStore) {
            return;
        }

        const primingEventId = await this._eventStore.storeEvent(streamId, {} as JSONRPCMessage);

        let primingEvent = `id: ${primingEventId}\ndata: \n\n`;
        if (this._retryInterval !== undefined) {
            primingEvent = `id: ${primingEventId}\nretry: ${this._retryInterval}\ndata: \n\n`;
        }
        controller.enqueue(encoder.encode(primingEvent));
    }

    /**
     * Handles GET requests for SSE stream
     */
    private async handleGetRequest(req: Request): Promise<Response> {
        // The client MUST include an Accept header, listing text/event-stream as a supported content type.
        const acceptHeader = req.headers.get('accept');
        if (!acceptHeader?.includes('text/event-stream')) {
            return this.createJsonErrorResponse(406, -32000, 'Not Acceptable: Client must accept text/event-stream');
        }

        // If an Mcp-Session-Id is returned by the server during initialization,
        // clients using the Streamable HTTP transport MUST include it
        // in the Mcp-Session-Id header on all of their subsequent HTTP requests.
        const sessionError = await this.validateSession(req);
        if (sessionError) {
            return sessionError;
        }
        const protocolError = this.validateProtocolVersion(req);
        if (protocolError) {
            return protocolError;
        }

        // Handle resumability: check for Last-Event-ID header
        if (this._eventStore) {
            const lastEventId = req.headers.get('last-event-id');
            if (lastEventId) {
                return this.replayEvents(lastEventId);
            }
        }

        // Check if there's already an active standalone SSE stream for this session
        if (this._streamMapping.get(this._standaloneSseStreamId) !== undefined) {
            // Only one GET SSE stream is allowed per session
            return this.createJsonErrorResponse(409, -32000, 'Conflict: Only one SSE stream is allowed per session');
        }

        const encoder = new TextEncoder();
        let streamController: ReadableStreamDefaultController<Uint8Array>;

        // Create a ReadableStream with a controller we can use to push SSE events
        const readable = new ReadableStream<Uint8Array>({
            start: controller => {
                streamController = controller;
            },
            cancel: () => {
                // Stream was cancelled by client
                this._streamMapping.delete(this._standaloneSseStreamId);
            }
        });

        const headers: Record<string, string> = {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive'
        };

        // After initialization, always include the session ID if we have one
        if (this.sessionId !== undefined) {
            headers['mcp-session-id'] = this.sessionId;
        }

        // Store the stream mapping with the controller for pushing data
        this._streamMapping.set(this._standaloneSseStreamId, {
            controller: streamController!,
            encoder,
            cleanup: () => {
                this._streamMapping.delete(this._standaloneSseStreamId);
                try {
                    streamController!.close();
                } catch {
                    // Controller might already be closed
                }
            }
        });

        return new Response(readable, { headers });
    }

    /**
     * Replays events that would have been sent after the specified event ID
     * Only used when resumability is enabled
     */
    private async replayEvents(lastEventId: string): Promise<Response> {
        if (!this._eventStore) {
            return this.createJsonErrorResponse(400, -32000, 'Event store not configured');
        }

        try {
            // If getStreamIdForEventId is available, use it for conflict checking
            let streamId: string | undefined;
            if (this._eventStore.getStreamIdForEventId) {
                streamId = await this._eventStore.getStreamIdForEventId(lastEventId);

                if (!streamId) {
                    return this.createJsonErrorResponse(400, -32000, 'Invalid event ID format');
                }

                // Check conflict with the SAME streamId we'll use for mapping
                if (this._streamMapping.get(streamId) !== undefined) {
                    return this.createJsonErrorResponse(409, -32000, 'Conflict: Stream already has an active connection');
                }
            }

            const headers: Record<string, string> = {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive'
            };

            if (this.sessionId !== undefined) {
                headers['mcp-session-id'] = this.sessionId;
            }

            // Create a ReadableStream with controller for SSE
            const encoder = new TextEncoder();
            let streamController: ReadableStreamDefaultController<Uint8Array>;

            const readable = new ReadableStream<Uint8Array>({
                start: controller => {
                    streamController = controller;
                },
                cancel: () => {
                    // Stream was cancelled by client
                    // Cleanup will be handled by the mapping
                }
            });

            // Replay events - returns the streamId for backwards compatibility
            const replayedStreamId = await this._eventStore.replayEventsAfter(lastEventId, {
                send: async (eventId: string, message: JSONRPCMessage) => {
                    const success = this.writeSSEEvent(streamController!, encoder, message, eventId);
                    if (!success) {
                        this.onerror?.(new Error('Failed replay events'));
                    }
                }
            });

            this._streamMapping.set(replayedStreamId, {
                controller: streamController!,
                encoder,
                cleanup: () => {
                    this._streamMapping.delete(replayedStreamId);
                    try {
                        streamController!.close();
                    } catch {
                        // Controller might already be closed
                    }
                }
            });

            return new Response(readable, { headers });
        } catch (error) {
            this.onerror?.(error as Error);
            return this.createJsonErrorResponse(500, -32000, 'Error replaying events');
        }
    }

    /**
     * Writes an event to an SSE stream via controller with proper formatting
     */
    private writeSSEEvent(
        controller: ReadableStreamDefaultController<Uint8Array>,
        encoder: TextEncoder,
        message: JSONRPCMessage,
        eventId?: string
    ): boolean {
        try {
            let eventData = `event: message\n`;
            // Include event ID if provided - this is important for resumability
            if (eventId) {
                eventData += `id: ${eventId}\n`;
            }
            eventData += `data: ${JSON.stringify(message)}\n\n`;
            controller.enqueue(encoder.encode(eventData));
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Handles unsupported requests (PUT, PATCH, etc.)
     */
    private handleUnsupportedRequest(): Response {
        return new Response(
            JSON.stringify({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'Method not allowed.'
                },
                id: null
            }),
            {
                status: 405,
                headers: {
                    Allow: 'GET, POST, DELETE',
                    'Content-Type': 'application/json'
                }
            }
        );
    }

    /**
     * Handles POST requests containing JSON-RPC messages
     */
    private async handlePostRequest(req: Request): Promise<Response> {
        try {
            // Validate the Accept header
            const acceptHeader = req.headers.get('accept');
            // The client MUST include an Accept header, listing both application/json and text/event-stream as supported content types.
            if (!acceptHeader?.includes('application/json') || !acceptHeader.includes('text/event-stream')) {
                return this.createJsonErrorResponse(
                    406,
                    -32000,
                    'Not Acceptable: Client must accept both application/json and text/event-stream'
                );
            }

            const ct = req.headers.get('content-type');
            if (!ct || !ct.includes('application/json')) {
                return this.createJsonErrorResponse(415, -32000, 'Unsupported Media Type: Content-Type must be application/json');
            }

            const requestInfo: RequestInfo = {
                headers: Object.fromEntries(req.headers.entries())
            };

            let rawMessage;
            try {
                rawMessage = await req.json();
            } catch {
                return this.createJsonErrorResponse(400, -32700, 'Parse error: Invalid JSON');
            }

            let messages: JSONRPCMessage[];

            // handle batch and single messages
            try {
                if (Array.isArray(rawMessage)) {
                    messages = rawMessage.map(msg => JSONRPCMessageSchema.parse(msg));
                } else {
                    messages = [JSONRPCMessageSchema.parse(rawMessage)];
                }
            } catch {
                return this.createJsonErrorResponse(400, -32700, 'Parse error: Invalid JSON-RPC message');
            }

            // Check if this is an initialization request
            // https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle/
            const isInitializationRequest = messages.some(isInitializeRequest);
            if (isInitializationRequest) {
                // If it's a server with session management and the session ID is already set we should reject the request
                // to avoid re-initialization.
                if (this._initialized && this.sessionId !== undefined) {
                    return this.createJsonErrorResponse(400, -32600, 'Invalid Request: Server already initialized');
                }
                if (messages.length > 1) {
                    return this.createJsonErrorResponse(400, -32600, 'Invalid Request: Only one initialization request is allowed');
                }
                this.sessionId = this.sessionIdGenerator?.();
                this._initialized = true;

                // Persist session state to external store if configured
                if (this.sessionId && this._sessionStore) {
                    const protocolVersion = req.headers.get('mcp-protocol-version') ?? DEFAULT_NEGOTIATED_PROTOCOL_VERSION;
                    await this._sessionStore.save(this.sessionId, {
                        initialized: true,
                        protocolVersion,
                        createdAt: Date.now()
                    });
                }

                // If we have a session ID and an onsessioninitialized handler, call it immediately
                // This is needed in cases where the server needs to keep track of multiple sessions
                if (this.sessionId && this._onsessioninitialized) {
                    await Promise.resolve(this._onsessioninitialized(this.sessionId));
                }
            }
            if (!isInitializationRequest) {
                // If an Mcp-Session-Id is returned by the server during initialization,
                // clients using the Streamable HTTP transport MUST include it
                // in the Mcp-Session-Id header on all of their subsequent HTTP requests.
                const sessionError = await this.validateSession(req);
                if (sessionError) {
                    return sessionError;
                }
                // Mcp-Protocol-Version header is required for all requests after initialization.
                const protocolError = this.validateProtocolVersion(req);
                if (protocolError) {
                    return protocolError;
                }
            }

            // check if it contains requests
            const hasRequests = messages.some(isJSONRPCRequest);

            if (!hasRequests) {
                // if it only contains notifications or responses, return 202
                for (const message of messages) {
                    this.onmessage?.(message, { requestInfo });
                }
                return new Response(null, { status: 202 });
            }

            // The default behavior is to use SSE streaming
            // but in some cases server will return JSON responses
            const streamId = crypto.randomUUID();

            if (this._enableJsonResponse) {
                // For JSON response mode, return a Promise that resolves when all responses are ready
                return new Promise<Response>(resolve => {
                    this._streamMapping.set(streamId, {
                        resolveJson: resolve,
                        cleanup: () => {
                            this._streamMapping.delete(streamId);
                        }
                    });

                    for (const message of messages) {
                        if (isJSONRPCRequest(message)) {
                            this._requestToStreamMapping.set(message.id, streamId);
                        }
                    }

                    for (const message of messages) {
                        this.onmessage?.(message, { requestInfo });
                    }
                });
            }

            // SSE streaming mode - use ReadableStream with controller for more reliable data pushing
            const encoder = new TextEncoder();
            let streamController: ReadableStreamDefaultController<Uint8Array>;

            const readable = new ReadableStream<Uint8Array>({
                start: controller => {
                    streamController = controller;
                },
                cancel: () => {
                    // Stream was cancelled by client
                    this._streamMapping.delete(streamId);
                }
            });

            const headers: Record<string, string> = {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            };

            // After initialization, always include the session ID if we have one
            if (this.sessionId !== undefined) {
                headers['mcp-session-id'] = this.sessionId;
            }

            // Store the response for this request to send messages back through this connection
            // We need to track by request ID to maintain the connection
            for (const message of messages) {
                if (isJSONRPCRequest(message)) {
                    this._streamMapping.set(streamId, {
                        controller: streamController!,
                        encoder,
                        cleanup: () => {
                            this._streamMapping.delete(streamId);
                            try {
                                streamController!.close();
                            } catch {
                                // Controller might already be closed
                            }
                        }
                    });
                    this._requestToStreamMapping.set(message.id, streamId);
                }
            }

            // Write priming event if event store is configured (after mapping is set up)
            await this.writePrimingEvent(streamController!, encoder, streamId);

            // handle each message
            for (const message of messages) {
                // Build closeSSEStream callback for requests when eventStore is configured
                let closeSSEStream: (() => void) | undefined;
                let closeStandaloneSSEStream: (() => void) | undefined;
                if (isJSONRPCRequest(message) && this._eventStore) {
                    closeSSEStream = () => {
                        this.closeSSEStream(message.id);
                    };
                    closeStandaloneSSEStream = () => {
                        this.closeStandaloneSSEStream();
                    };
                }

                this.onmessage?.(message, { requestInfo, closeSSEStream, closeStandaloneSSEStream });
            }
            // The server SHOULD NOT close the SSE stream before sending all JSON-RPC responses
            // This will be handled by the send() method when responses are ready

            return new Response(readable, { status: 200, headers });
        } catch (error) {
            // return JSON-RPC formatted error
            this.onerror?.(error as Error);
            return this.createJsonErrorResponse(400, -32700, 'Parse error');
        }
    }

    /**
     * Handles DELETE requests to terminate sessions
     */
    private async handleDeleteRequest(req: Request): Promise<Response> {
        const sessionError = await this.validateSession(req);
        if (sessionError) {
            return sessionError;
        }
        const protocolError = this.validateProtocolVersion(req);
        if (protocolError) {
            return protocolError;
        }

        // Delete session from external store if configured
        if (this.sessionId && this._sessionStore) {
            await this._sessionStore.delete(this.sessionId);
        }

        await Promise.resolve(this._onsessionclosed?.(this.sessionId!));
        await this.close();
        return new Response(null, { status: 200 });
    }

    /**
     * Validates session ID for non-initialization requests.
     * In serverless mode with sessionStore, this will hydrate session state from the store.
     * Returns Response error if invalid, undefined otherwise
     */
    private async validateSession(req: Request): Promise<Response | undefined> {
        if (this.sessionIdGenerator === undefined) {
            // If the sessionIdGenerator ID is not set, the session management is disabled
            // and we don't need to validate the session ID
            return undefined;
        }

        const sessionId = req.headers.get('mcp-session-id');

        if (!sessionId) {
            // Non-initialization requests without a session ID should return 400 Bad Request
            return this.createJsonErrorResponse(400, -32000, 'Bad Request: Mcp-Session-Id header is required');
        }

        // If sessionStore is configured, try to hydrate session from external store
        // This enables serverless mode where each request may be on a fresh instance
        if (this._sessionStore) {
            const sessionState = await this._sessionStore.get(sessionId);
            if (sessionState && sessionState.initialized) {
                // Hydrate this transport instance with the session state
                this.sessionId = sessionId;
                this._initialized = true;
                return undefined;
            }
            // Session not found in store
            return this.createJsonErrorResponse(404, -32001, 'Session not found');
        }

        // In-memory mode: check local state
        if (!this._initialized) {
            // If the server has not been initialized yet, reject all requests
            return this.createJsonErrorResponse(400, -32000, 'Bad Request: Server not initialized');
        }

        if (sessionId !== this.sessionId) {
            // Reject requests with invalid session ID with 404 Not Found
            return this.createJsonErrorResponse(404, -32001, 'Session not found');
        }

        return undefined;
    }

    private validateProtocolVersion(req: Request): Response | undefined {
        const protocolVersion = req.headers.get('mcp-protocol-version') ?? DEFAULT_NEGOTIATED_PROTOCOL_VERSION;

        if (!SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
            return this.createJsonErrorResponse(
                400,
                -32000,
                `Bad Request: Unsupported protocol version (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')})`
            );
        }
        return undefined;
    }

    async close(): Promise<void> {
        // Close all SSE connections
        this._streamMapping.forEach(({ cleanup }) => {
            cleanup();
        });
        this._streamMapping.clear();

        // Clear any pending responses
        this._requestResponseMap.clear();
        this.onclose?.();
    }

    /**
     * Close an SSE stream for a specific request, triggering client reconnection.
     * Use this to implement polling behavior during long-running operations -
     * client will reconnect after the retry interval specified in the priming event.
     */
    closeSSEStream(requestId: RequestId): void {
        const streamId = this._requestToStreamMapping.get(requestId);
        if (!streamId) return;

        const stream = this._streamMapping.get(streamId);
        if (stream) {
            stream.cleanup();
        }
    }

    /**
     * Close the standalone GET SSE stream, triggering client reconnection.
     * Use this to implement polling behavior for server-initiated notifications.
     */
    closeStandaloneSSEStream(): void {
        const stream = this._streamMapping.get(this._standaloneSseStreamId);
        if (stream) {
            stream.cleanup();
        }
    }

    async send(message: JSONRPCMessage, options?: { relatedRequestId?: RequestId }): Promise<void> {
        let requestId = options?.relatedRequestId;
        if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
            // If the message is a response, use the request ID from the message
            requestId = message.id;
        }

        // Check if this message should be sent on the standalone SSE stream (no request ID)
        // Ignore notifications from tools (which have relatedRequestId set)
        // Those will be sent via dedicated response SSE streams
        if (requestId === undefined) {
            // For standalone SSE streams, we can only send requests and notifications
            if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
                throw new Error('Cannot send a response on a standalone SSE stream unless resuming a previous client request');
            }

            // Generate and store event ID if event store is provided
            // Store even if stream is disconnected so events can be replayed on reconnect
            let eventId: string | undefined;
            if (this._eventStore) {
                // Stores the event and gets the generated event ID
                eventId = await this._eventStore.storeEvent(this._standaloneSseStreamId, message);
            }

            const standaloneSse = this._streamMapping.get(this._standaloneSseStreamId);
            if (standaloneSse === undefined) {
                // Stream is disconnected - event is stored for replay, nothing more to do
                return;
            }

            // Send the message to the standalone SSE stream
            if (standaloneSse.controller && standaloneSse.encoder) {
                this.writeSSEEvent(standaloneSse.controller, standaloneSse.encoder, message, eventId);
            }
            return;
        }

        // Get the response for this request
        const streamId = this._requestToStreamMapping.get(requestId);
        if (!streamId) {
            throw new Error(`No connection established for request ID: ${String(requestId)}`);
        }

        const stream = this._streamMapping.get(streamId);

        if (!this._enableJsonResponse && stream?.controller && stream?.encoder) {
            // For SSE responses, generate event ID if event store is provided
            let eventId: string | undefined;

            if (this._eventStore) {
                eventId = await this._eventStore.storeEvent(streamId, message);
            }
            // Write the event to the response stream
            this.writeSSEEvent(stream.controller, stream.encoder, message, eventId);
        }

        if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
            this._requestResponseMap.set(requestId, message);
            const relatedIds = Array.from(this._requestToStreamMapping.entries())
                .filter(([_, sid]) => sid === streamId)
                .map(([id]) => id);

            // Check if we have responses for all requests using this connection
            const allResponsesReady = relatedIds.every(id => this._requestResponseMap.has(id));

            if (allResponsesReady) {
                if (!stream) {
                    throw new Error(`No connection established for request ID: ${String(requestId)}`);
                }
                if (this._enableJsonResponse && stream.resolveJson) {
                    // All responses ready, send as JSON
                    const headers: Record<string, string> = {
                        'Content-Type': 'application/json'
                    };
                    if (this.sessionId !== undefined) {
                        headers['mcp-session-id'] = this.sessionId;
                    }

                    const responses = relatedIds.map(id => this._requestResponseMap.get(id)!);

                    if (responses.length === 1) {
                        stream.resolveJson(new Response(JSON.stringify(responses[0]), { status: 200, headers }));
                    } else {
                        stream.resolveJson(new Response(JSON.stringify(responses), { status: 200, headers }));
                    }
                } else {
                    // End the SSE stream
                    stream.cleanup();
                }
                // Clean up
                for (const id of relatedIds) {
                    this._requestResponseMap.delete(id);
                    this._requestToStreamMapping.delete(id);
                }
            }
        }
    }
}
