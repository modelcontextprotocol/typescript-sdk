/**
 * Node.js Streamable HTTP Server Transport
 *
 * This is a thin wrapper around {@linkcode WebStandardStreamableHTTPServerTransport} that provides
 * compatibility with Node.js HTTP server (`IncomingMessage`/`ServerResponse`).
 *
 * For web-standard environments (Cloudflare Workers, Deno, Bun), use {@linkcode WebStandardStreamableHTTPServerTransport} directly.
 */

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
import { SdkErrorCode, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

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
 * - Each transport instance serves exactly ONE request: construct a fresh
 *   transport (and server instance) per request — reusing a stateless
 *   transport across requests throws (the guard lives in the wrapped
 *   {@linkcode WebStandardStreamableHTTPServerTransport})
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
 * // A stateless transport serves exactly one request: construct a fresh
 * // transport + server pair per request — reusing a stateless transport
 * // across requests throws.
 * const server = new McpServer({ name: 'my-server', version: '1.0.0' });
 *
 * const transport = new NodeStreamableHTTPServerTransport({
 *     sessionIdGenerator: undefined
 * });
 *
 * await server.connect(transport);
 * await transport.handleRequest(incomingRequest, serverResponse);
 * ```
 *
 * @example Using with a pre-parsed request body (e.g. Express)
 * ```ts source="./streamableHttp.examples.ts#NodeStreamableHTTPServerTransport_express"
 * app.post('/mcp', async (req, res) => {
 *     // Stateless serving: a fresh transport + server pair per request.
 *     const server = new McpServer({ name: 'my-server', version: '1.0.0' });
 *     const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
 *     await server.connect(transport);
 *     await transport.handleRequest(req, res, req.body);
 * });
 * ```
 */
export class NodeStreamableHTTPServerTransport implements Transport {
    private _webStandardTransport: WebStandardStreamableHTTPServerTransport;
    private _requestListener: ReturnType<typeof getRequestListener>;
    // Store auth and parsedBody per request for passing through to handleRequest
    private _requestContext: WeakMap<Request, { authInfo?: AuthInfo; parsedBody?: unknown }> = new WeakMap();

    constructor(options: StreamableHTTPServerTransportOptions = {}) {
        this._webStandardTransport = new WebStandardStreamableHTTPServerTransport(options);

        // Create a request listener that wraps the web standard transport
        // getRequestListener converts Node.js HTTP to Web Standard and properly handles SSE streaming
        // overrideGlobalObjects: false prevents Hono from overwriting global Response, which would
        // break frameworks like Next.js whose response classes extend the native Response
        this._requestListener = getRequestListener(
            async (webRequest: Request) => {
                // Get context if available (set during handleRequest)
                const context = this._requestContext.get(webRequest);
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
        // Fail fast before delegating: once getRequestListener is invoked, a
        // rejected dispatch is committed to `res` as an empty 500 before the
        // rejection can surface, leaving the caller unable to shape its own
        // error response. Checking up front rejects with nothing written to
        // `res`. The check lives on the wrapped transport (single source).
        this._webStandardTransport.assertNotReused();

        // Store context for this request to pass through auth and parsedBody
        // We need to intercept the request creation to attach this context
        const authInfo = req.auth;

        // Create a custom handler that includes our context
        // overrideGlobalObjects: false prevents Hono from overwriting global Response, which would
        // break frameworks like Next.js whose response classes extend the native Response
        let dispatchError: unknown;
        const handler = getRequestListener(
            async (webRequest: Request) => {
                try {
                    return await this._webStandardTransport.handleRequest(webRequest, {
                        authInfo,
                        parsedBody
                    });
                } catch (error) {
                    dispatchError = error;
                    throw error;
                }
            },
            { overrideGlobalObjects: false }
        );

        // Delegate to the request listener which handles all the Node.js <-> Web Standard conversion
        // including proper SSE streaming support
        await handler(req, res);

        // Backstop for concurrent calls racing the up-front check (the
        // single-use flag is set inside the wrapped handleRequest, after the
        // request conversion): getRequestListener absorbs a rejected dispatch
        // into a generic 500, which would swallow the single-use throw.
        // Re-raise it so the documented behavior (reusing a stateless
        // transport across requests throws at the call site) holds on this
        // path too. Other dispatch errors keep the existing 500-response
        // behavior. Matched by code, not `instanceof`, so the check also
        // holds if bundling ever yields two copies of the error class.
        if (dispatchError instanceof Error && (dispatchError as { code?: unknown }).code === SdkErrorCode.StatelessTransportReuse) {
            throw dispatchError;
        }
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
