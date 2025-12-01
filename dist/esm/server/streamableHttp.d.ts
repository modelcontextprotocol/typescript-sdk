import { IncomingMessage, ServerResponse } from 'node:http';
import { Transport } from '../shared/transport.js';
import { MessageExtraInfo, JSONRPCMessage, RequestId } from '../types.js';
import { AuthInfo } from './auth/types.js';
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
    replayEventsAfter(lastEventId: EventId, { send }: {
        send: (eventId: EventId, message: JSONRPCMessage) => Promise<void>;
    }): Promise<StreamId>;
}
/**
 * Session data structure for distributed session storage
 */
export interface SessionData {
    /**
     * The unique session identifier
     */
    sessionId: string;
    /**
     * Whether the session has been initialized (received initialize request)
     */
    initialized: boolean;
    /**
     * Timestamp when the session was created (Unix ms)
     */
    createdAt: number;
    /**
     * Timestamp of last activity (Unix ms)
     */
    lastActivity: number;
    /**
     * Optional metadata for custom use cases (e.g., serverId, userId)
     */
    metadata?: Record<string, unknown>;
}
/**
 * Interface for distributed session storage (e.g., Redis, PostgreSQL, etc.)
 *
 * This interface enables multi-node/multi-pod deployments where session state
 * must be shared across multiple server instances. Without this, sessions are
 * stored in-memory and requests routed to different pods will fail.
 *
 * Usage example with Redis:
 * ```typescript
 * const sessionStore: SessionStore = {
 *   async storeSession(sessionId, data) {
 *     await redis.setex(`mcp:session:${sessionId}`, 3600, JSON.stringify(data));
 *   },
 *   async getSession(sessionId) {
 *     const data = await redis.get(`mcp:session:${sessionId}`);
 *     return data ? JSON.parse(data) : null;
 *   },
 *   async updateSessionActivity(sessionId) {
 *     const data = await this.getSession(sessionId);
 *     if (data) {
 *       data.lastActivity = Date.now();
 *       await this.storeSession(sessionId, data);
 *     }
 *   },
 *   async deleteSession(sessionId) {
 *     await redis.del(`mcp:session:${sessionId}`);
 *   },
 *   async sessionExists(sessionId) {
 *     return await redis.exists(`mcp:session:${sessionId}`) === 1;
 *   }
 * };
 *
 * const transport = new StreamableHTTPServerTransport({
 *   sessionIdGenerator: () => randomUUID(),
 *   sessionStore: sessionStore
 * });
 * ```
 */
export interface SessionStore {
    /**
     * Store session data
     * @param sessionId The session identifier
     * @param data The session data to store
     */
    storeSession(sessionId: string, data: SessionData): Promise<void>;
    /**
     * Retrieve session data
     * @param sessionId The session identifier
     * @returns The session data, or null if not found
     */
    getSession(sessionId: string): Promise<SessionData | null>;
    /**
     * Update session activity timestamp (e.g., refresh TTL)
     * @param sessionId The session identifier
     */
    updateSessionActivity(sessionId: string): Promise<void>;
    /**
     * Delete a session
     * @param sessionId The session identifier
     */
    deleteSession(sessionId: string): Promise<void>;
    /**
     * Check if a session exists
     * @param sessionId The session identifier
     * @returns true if the session exists
     */
    sessionExists(sessionId: string): Promise<boolean>;
}
/**
 * Session storage mode for the transport
 */
export type SessionStorageMode = 'memory' | 'external';
/**
 * Configuration options for StreamableHTTPServerTransport
 */
export interface StreamableHTTPServerTransportOptions {
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
     * StreamableHTTPServerTransport after a request is completed while still keeping the
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
     * Session storage mode - explicitly choose between in-memory and external storage.
     *
     * - 'memory': Sessions stored in process memory (single-node only, default)
     * - 'external': Sessions stored in external store (requires sessionStore option)
     *
     * When 'external' is selected but sessionStore is not provided, an error will be thrown.
     *
     * @default 'memory'
     */
    sessionStorageMode?: SessionStorageMode;
    /**
     * Session store for distributed session management.
     * Required when sessionStorageMode is 'external'.
     *
     * This enables multi-node/multi-pod deployments where requests may be routed
     * to different server instances.
     *
     * When sessionStore is provided with mode 'external':
     * - Session validation checks the external store instead of local memory
     * - Session data is persisted across server restarts
     * - Multiple server instances can share session state
     * - Cross-pod session recovery is handled automatically
     *
     * @example
     * ```typescript
     * // Redis session store for multi-pod deployment
     * const transport = new StreamableHTTPServerTransport({
     *   sessionIdGenerator: () => randomUUID(),
     *   sessionStorageMode: 'external',
     *   sessionStore: new RedisSessionStore({
     *     redis: redisClient,
     *     keyPrefix: 'mcp:session:',
     *     ttlSeconds: 3600
     *   })
     * });
     * ```
     */
    sessionStore?: SessionStore;
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
}
/**
 * Server transport for Streamable HTTP: this implements the MCP Streamable HTTP transport specification.
 * It supports both SSE streaming and direct HTTP responses.
 *
 * Usage example:
 *
 * ```typescript
 * // Stateful mode - server sets the session ID
 * const statefulTransport = new StreamableHTTPServerTransport({
 *   sessionIdGenerator: () => randomUUID(),
 * });
 *
 * // Stateless mode - explicitly set session ID to undefined
 * const statelessTransport = new StreamableHTTPServerTransport({
 *   sessionIdGenerator: undefined,
 * });
 *
 * // Using with pre-parsed request body
 * app.post('/mcp', (req, res) => {
 *   transport.handleRequest(req, res, req.body);
 * });
 *
 * // With distributed session store (Redis) for multi-pod deployments
 * const transport = new StreamableHTTPServerTransport({
 *   sessionIdGenerator: () => randomUUID(),
 *   sessionStore: myRedisSessionStore
 * });
 * ```
 *
 * In stateful mode:
 * - Session ID is generated and included in response headers
 * - Session ID is always included in initialization responses
 * - Requests with invalid session IDs are rejected with 404 Not Found
 * - Non-initialization requests without a session ID are rejected with 400 Bad Request
 * - State is maintained in-memory (connections, message history) or externally via sessionStore
 *
 * In stateless mode:
 * - No Session ID is included in any responses
 * - No session validation is performed
 */
export declare class StreamableHTTPServerTransport implements Transport {
    private sessionIdGenerator;
    private _started;
    private _streamMapping;
    private _requestToStreamMapping;
    private _requestResponseMap;
    private _initialized;
    private _enableJsonResponse;
    private _standaloneSseStreamId;
    private _eventStore?;
    private _sessionStorageMode;
    private _sessionStore?;
    private _onsessioninitialized?;
    private _onsessionclosed?;
    private _allowedHosts?;
    private _allowedOrigins?;
    private _enableDnsRebindingProtection;
    private _retryInterval?;
    sessionId?: string;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
    constructor(options: StreamableHTTPServerTransportOptions);
    /**
     * Returns the current session storage mode
     */
    get sessionStorageMode(): SessionStorageMode;
    /**
     * Returns true if using external session storage
     */
    get isUsingExternalSessionStore(): boolean;
    /**
     * Starts the transport. This is required by the Transport interface but is a no-op
     * for the Streamable HTTP transport as connections are managed per-request.
     */
    start(): Promise<void>;
    /**
     * Validates request headers for DNS rebinding protection.
     * @returns Error message if validation fails, undefined if validation passes.
     */
    private validateRequestHeaders;
    /**
     * Handles an incoming HTTP request, whether GET or POST
     */
    handleRequest(req: IncomingMessage & {
        auth?: AuthInfo;
    }, res: ServerResponse, parsedBody?: unknown): Promise<void>;
    /**
     * Writes a priming event to establish resumption capability.
     * Only sends if eventStore is configured (opt-in for resumability).
     */
    private _maybeWritePrimingEvent;
    /**
     * Handles GET requests for SSE stream
     */
    private handleGetRequest;
    /**
     * Replays events that would have been sent after the specified event ID
     * Only used when resumability is enabled
     */
    private replayEvents;
    /**
     * Writes an event to the SSE stream with proper formatting
     */
    private writeSSEEvent;
    /**
     * Handles unsupported requests (PUT, PATCH, etc.)
     */
    private handleUnsupportedRequest;
    /**
     * Handles POST requests containing JSON-RPC messages
     */
    private handlePostRequest;
    /**
     * Handles DELETE requests to terminate sessions
     */
    private handleDeleteRequest;
    /**
     * Validates session ID for non-initialization requests.
     *
     * When sessionStore is provided, validation checks the external store,
     * enabling multi-node deployments where different pods may handle requests
     * for the same session.
     *
     * Returns true if the session is valid, false otherwise.
     */
    private validateSession;
    private validateProtocolVersion;
    close(): Promise<void>;
    /**
     * Close an SSE stream for a specific request, triggering client reconnection.
     * Use this to implement polling behavior during long-running operations -
     * client will reconnect after the retry interval specified in the priming event.
     */
    closeSSEStream(requestId: RequestId): void;
    send(message: JSONRPCMessage, options?: {
        relatedRequestId?: RequestId;
    }): Promise<void>;
}
//# sourceMappingURL=streamableHttp.d.ts.map