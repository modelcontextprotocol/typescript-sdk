/**
 * Node.js HTTP Streamable HTTP Server Transport
 *
 * This is a thin wrapper around `FetchStreamableHTTPServerTransport` that provides
 * compatibility with Node.js HTTP server (IncomingMessage/ServerResponse).
 *
 * For web-standard environments (Cloudflare Workers, Deno, Bun), use `FetchStreamableHTTPServerTransport` directly.
 */

import { IncomingMessage, ServerResponse } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Transport } from '../shared/transport.js';
import { AuthInfo } from './auth/types.js';
import { MessageExtraInfo, JSONRPCMessage, RequestId } from '../types.js';
import {
    FetchStreamableHTTPServerTransport,
    FetchStreamableHTTPServerTransportOptions,
    EventStore,
    StreamId,
    EventId
} from './fetchStreamableHttp.js';

// Re-export types from the core transport for backward compatibility
export type { EventStore, StreamId, EventId };

/**
 * Configuration options for StreamableHTTPServerTransport
 *
 * This is an alias for FetchStreamableHTTPServerTransportOptions for backward compatibility.
 */
export type StreamableHTTPServerTransportOptions = FetchStreamableHTTPServerTransportOptions;

/**
 * Server transport for Streamable HTTP: this implements the MCP Streamable HTTP transport specification.
 * It supports both SSE streaming and direct HTTP responses.
 *
 * This is a wrapper around `FetchStreamableHTTPServerTransport` that provides Node.js HTTP compatibility.
 * It uses the `@hono/node-server` library to convert between Node.js HTTP and Web Standard APIs.
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
 */
export class StreamableHTTPServerTransport implements Transport {
    private _fetchTransport: FetchStreamableHTTPServerTransport;
    private _requestListener: ReturnType<typeof getRequestListener>;
    // Store auth and parsedBody per request for passing through to handleRequest
    private _requestContext: WeakMap<Request, { authInfo?: AuthInfo; parsedBody?: unknown }> = new WeakMap();

    constructor(options: StreamableHTTPServerTransportOptions) {
        this._fetchTransport = new FetchStreamableHTTPServerTransport(options);

        // Create a request listener that wraps the fetch transport
        // getRequestListener converts Node.js HTTP to Web Standard and properly handles SSE streaming
        this._requestListener = getRequestListener(async (webRequest: Request) => {
            // Get context if available (set during handleRequest)
            const context = this._requestContext.get(webRequest);
            return this._fetchTransport.handleRequest(webRequest, {
                authInfo: context?.authInfo,
                parsedBody: context?.parsedBody
            });
        });
    }

    /**
     * Gets the session ID for this transport instance.
     */
    get sessionId(): string | undefined {
        return this._fetchTransport.sessionId;
    }

    /**
     * Sets callback for when the transport is closed.
     */
    set onclose(handler: (() => void) | undefined) {
        this._fetchTransport.onclose = handler;
    }

    get onclose(): (() => void) | undefined {
        return this._fetchTransport.onclose;
    }

    /**
     * Sets callback for transport errors.
     */
    set onerror(handler: ((error: Error) => void) | undefined) {
        this._fetchTransport.onerror = handler;
    }

    get onerror(): ((error: Error) => void) | undefined {
        return this._fetchTransport.onerror;
    }

    /**
     * Sets callback for incoming messages.
     */
    set onmessage(handler: ((message: JSONRPCMessage, extra?: MessageExtraInfo) => void) | undefined) {
        this._fetchTransport.onmessage = handler;
    }

    get onmessage(): ((message: JSONRPCMessage, extra?: MessageExtraInfo) => void) | undefined {
        return this._fetchTransport.onmessage;
    }

    /**
     * Starts the transport. This is required by the Transport interface but is a no-op
     * for the Streamable HTTP transport as connections are managed per-request.
     */
    async start(): Promise<void> {
        return this._fetchTransport.start();
    }

    /**
     * Closes the transport and all active connections.
     */
    async close(): Promise<void> {
        return this._fetchTransport.close();
    }

    /**
     * Sends a JSON-RPC message through the transport.
     */
    async send(message: JSONRPCMessage, options?: { relatedRequestId?: RequestId }): Promise<void> {
        return this._fetchTransport.send(message, options);
    }

    /**
     * Handles an incoming HTTP request, whether GET or POST.
     *
     * This method converts Node.js HTTP objects to Web Standard Request/Response
     * and delegates to the underlying FetchStreamableHTTPServerTransport.
     *
     * @param req - Node.js IncomingMessage, optionally with auth property from middleware
     * @param res - Node.js ServerResponse
     * @param parsedBody - Optional pre-parsed body from body-parser middleware
     */
    async handleRequest(req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse, parsedBody?: unknown): Promise<void> {
        // Store context for this request to pass through auth and parsedBody
        // We need to intercept the request creation to attach this context
        const authInfo = req.auth;

        // Create a custom handler that includes our context
        const handler = getRequestListener(async (webRequest: Request) => {
            return this._fetchTransport.handleRequest(webRequest, {
                authInfo,
                parsedBody
            });
        });

        // Delegate to the request listener which handles all the Node.js <-> Web Standard conversion
        // including proper SSE streaming support
        await handler(req, res);
    }

    /**
     * Close an SSE stream for a specific request, triggering client reconnection.
     * Use this to implement polling behavior during long-running operations -
     * client will reconnect after the retry interval specified in the priming event.
     */
    closeSSEStream(requestId: RequestId): void {
        this._fetchTransport.closeSSEStream(requestId);
    }

    /**
     * Close the standalone GET SSE stream, triggering client reconnection.
     * Use this to implement polling behavior for server-initiated notifications.
     */
    closeStandaloneSSEStream(): void {
        this._fetchTransport.closeStandaloneSSEStream();
    }
}
