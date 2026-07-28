/**
 * Node.js Streamable HTTP Server Transport
 *
 * This is a thin wrapper around {@linkcode WebStandardStreamableHTTPServerTransport} that provides
 * compatibility with Node.js HTTP server (`IncomingMessage`/`ServerResponse`).
 *
 * For web-standard environments (Cloudflare Workers, Deno, Bun), use {@linkcode WebStandardStreamableHTTPServerTransport} directly.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { getRequestListener } from '@hono/node-server';
import type {
    AuthInfo,
    JSONRPCMessage,
    MessageExtraInfo,
    RequestId,
    Transport,
    WebStandardStreamableHTTPServerTransportOptions
} from '@modelcontextprotocol/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

/**
 * Configuration options for {@linkcode NodeStreamableHTTPServerTransport}
 *
 * This is an alias for {@linkcode WebStandardStreamableHTTPServerTransportOptions} for backward compatibility.
 */
export type StreamableHTTPServerTransportOptions = WebStandardStreamableHTTPServerTransportOptions;

/**
 * Server transport for Streamable HTTP: this implements the MCP Streamable HTTP transport specification.
 * It supports both SSE streaming and direct HTTP responses.
 *
 * This is a wrapper around {@linkcode WebStandardStreamableHTTPServerTransport} that provides Node.js HTTP compatibility.
 * It uses the `@hono/node-server` library to convert between Node.js HTTP and Web Standard APIs.
 *
 * In stateful mode:
 * - Session ID is generated and included in response headers
 * - Session ID is always included in initialization responses
 * - Requests with invalid session IDs are rejected with `404 Not Found`
 * - Non-initialization requests without a session ID are rejected with `400 Bad Request`
 * - State is maintained in-memory (connections, message history)
 *
 * In stateless mode:
 * - No Session ID is included in any responses
 * - No session validation is performed
 *
 * @example Stateful setup
 * ```ts source="./streamableHttp.examples.ts#NodeStreamableHTTPServerTransport_stateful"
 * const server = new McpServer({ name: 'my-server', version: '1.0.0' });
 *
 * const transport = new NodeStreamableHTTPServerTransport({
 *     sessionIdGenerator: () => randomUUID()
 * });
 *
 * await server.connect(transport);
 * ```
 *
 * @example Stateless setup
 * ```ts source="./streamableHttp.examples.ts#NodeStreamableHTTPServerTransport_stateless"
 * const transport = new NodeStreamableHTTPServerTransport({
 *     sessionIdGenerator: undefined
 * });
 * ```
 *
 * @example Using with a pre-parsed request body (e.g. Express)
 * ```ts source="./streamableHttp.examples.ts#NodeStreamableHTTPServerTransport_express"
 * app.post('/mcp', (req, res) => {
 *     transport.handleRequest(req, res, req.body);
 * });
 * ```
 */
export class NodeStreamableHTTPServerTransport implements Transport {
    private _webStandardTransport: WebStandardStreamableHTTPServerTransport;
    private _requestListener: ReturnType<typeof getRequestListener>;
    // Pass per-request context (auth, parsed body) through to the shared request listener.
    // AsyncLocalStorage is used because getRequestListener creates the Web Standard Request
    // internally — we have no reference to it before the callback fires, so a WeakMap keyed
    // by Request cannot work. AsyncLocalStorage is concurrent-safe and appropriate here since
    // this module is Node.js-specific.
    private _requestContext = new AsyncLocalStorage<{ authInfo?: AuthInfo; parsedBody?: unknown }>();

    constructor(options: StreamableHTTPServerTransportOptions = {}) {
        this._webStandardTransport = new WebStandardStreamableHTTPServerTransport(options);

        // Create a single request listener at construction time, reused for every request.
        // getRequestListener converts Node.js HTTP to Web Standard and properly handles SSE streaming.
        // overrideGlobalObjects: false prevents Hono from overwriting global Response, which would
        // break frameworks like Next.js whose response classes extend the native Response.
        this._requestListener = getRequestListener(
            async (webRequest: Request) => {
                const context = this._requestContext.getStore();
                return this._webStandardTransport.handleRequest(webRequest, {
                    authInfo: context?.authInfo,
                    parsedBody: context?.parsedBody
                });
            },
            { overrideGlobalObjects: false }
        );
    }

    /**
     * Gets the session ID for this transport instance.
     */
    get sessionId(): string | undefined {
        return this._webStandardTransport.sessionId;
    }

    /**
     * Sets callback for when the transport is closed.
     */
    set onclose(handler: (() => void) | undefined) {
        this._webStandardTransport.onclose = handler;
    }

    get onclose(): (() => void) | undefined {
        return this._webStandardTransport.onclose;
    }

    /**
     * Sets callback for transport errors.
     */
    set onerror(handler: ((error: Error) => void) | undefined) {
        this._webStandardTransport.onerror = handler;
    }

    get onerror(): ((error: Error) => void) | undefined {
        return this._webStandardTransport.onerror;
    }

    /**
     * Sets callback for incoming messages.
     */
    set onmessage(handler: ((message: JSONRPCMessage, extra?: MessageExtraInfo) => void) | undefined) {
        this._webStandardTransport.onmessage = handler;
    }

    get onmessage(): ((message: JSONRPCMessage, extra?: MessageExtraInfo) => void) | undefined {
        return this._webStandardTransport.onmessage;
    }

    /**
     * Starts the transport. This is required by the {@linkcode Transport} interface but is a no-op
     * for the Streamable HTTP transport as connections are managed per-request.
     */
    async start(): Promise<void> {
        return this._webStandardTransport.start();
    }

    /**
     * Closes the transport and all active connections.
     */
    async close(): Promise<void> {
        return this._webStandardTransport.close();
    }

    /**
     * Sends a JSON-RPC message through the transport.
     */
    async send(message: JSONRPCMessage, options?: { relatedRequestId?: RequestId }): Promise<void> {
        return this._webStandardTransport.send(message, options);
    }

    /**
     * Forwards the supported protocol versions to the wrapped Web Standard
     * transport for `MCP-Protocol-Version` header validation. Called by the
     * protocol layer during connect; without this delegation a server's
     * `supportedProtocolVersions` option never reached the Node adapter's
     * header validation.
     */
    setSupportedProtocolVersions(versions: string[]): void {
        this._webStandardTransport.setSupportedProtocolVersions(versions);
    }

    /**
     * Handles an incoming HTTP request, whether `GET` or `POST`.
     *
     * This method converts Node.js HTTP objects to Web Standard Request/Response
     * and delegates to the underlying {@linkcode WebStandardStreamableHTTPServerTransport}.
     *
     * @param req - Node.js `IncomingMessage`, optionally with `auth` property from middleware
     * @param res - Node.js `ServerResponse`
     * @param parsedBody - Optional pre-parsed body from body-parser middleware
     */
    async handleRequest(req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse, parsedBody?: unknown): Promise<void> {
        // Run the shared request listener within an AsyncLocalStorage context so the
        // callback can retrieve authInfo and parsedBody without creating a new
        // getRequestListener per request.
        await this._requestContext.run({ authInfo: req.auth, parsedBody }, () => {
            return this._requestListener(req, res);
        });
    }

    /**
     * Close an SSE stream for a specific request, triggering client reconnection.
     * Use this to implement polling behavior during long-running operations -
     * client will reconnect after the retry interval specified in the priming event.
     */
    closeSSEStream(requestId: RequestId): void {
        this._webStandardTransport.closeSSEStream(requestId);
    }

    /**
     * Close the standalone GET SSE stream, triggering client reconnection.
     * Use this to implement polling behavior for server-initiated notifications.
     */
    closeStandaloneSSEStream(): void {
        this._webStandardTransport.closeStandaloneSSEStream();
    }
}
