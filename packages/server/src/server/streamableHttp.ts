/**
 * Node.js HTTP Streamable HTTP Server Transport
 *
 * This is a thin wrapper around `WebStandardStreamableHTTPServerTransport` that provides
 * compatibility with Node.js HTTP server (IncomingMessage/ServerResponse).
 *
 * For web-standard environments (Cloudflare Workers, Deno, Bun), use `WebStandardStreamableHTTPServerTransport` directly.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { URL } from 'node:url';

import type { AuthInfo, JSONRPCMessage, MessageExtraInfo, RequestId, Transport } from '@modelcontextprotocol/core';

import type { WebStandardStreamableHTTPServerTransportOptions } from './webStandardStreamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from './webStandardStreamableHttp.js';

/**
 * Configuration options for NodeStreamableHTTPServerTransport
 *
 * This is an alias for WebStandardStreamableHTTPServerTransportOptions for backward compatibility.
 */
export type NodeStreamableHTTPServerTransportOptions = WebStandardStreamableHTTPServerTransportOptions;

type NodeToWebRequestOptions = {
    parsedBody?: unknown;
};

function getRequestUrl(req: IncomingMessage): URL {
    const host = req.headers.host ?? 'localhost';
    const isTls = Boolean((req.socket as { encrypted?: boolean } | undefined)?.encrypted);
    const protocol = isTls ? 'https' : 'http';
    const path = req.url ?? '/';
    return new URL(path, `${protocol}://${host}`);
}

function toHeaders(req: IncomingMessage): Headers {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
            // Preserve multi-value headers as a comma-joined value.
            // (Set-Cookie does not appear on requests; this is fine here.)
            headers.set(key, value.join(', '));
        } else {
            headers.set(key, value);
        }
    }
    return headers;
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

async function nodeToWebRequest(req: IncomingMessage, options?: NodeToWebRequestOptions): Promise<Request> {
    const url = getRequestUrl(req);
    const method = req.method ?? 'GET';
    const headers = toHeaders(req);

    // If an upstream framework already parsed the body, the IncomingMessage stream
    // may be consumed; rely on parsedBody instead of trying to read again.
    if (options?.parsedBody !== undefined) {
        return new Request(url, { method, headers });
    }

    // Only attach bodies for methods that can carry one.
    if (method === 'GET' || method === 'HEAD') {
        return new Request(url, { method, headers });
    }

    const body = await readBody(req);
    return new Request(url, { method, headers, body });
}

function writeWebResponse(res: ServerResponse, webResponse: Response): Promise<void> {
    res.statusCode = webResponse.status;

    // Prefer undici's multi Set-Cookie support when available.
    // Note: must call with the correct `this` (undici brand-checks Headers).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const getSetCookie = (webResponse.headers as any).getSetCookie as (() => string[]) | undefined;
    const setCookies = typeof getSetCookie === 'function' ? getSetCookie.call(webResponse.headers) : undefined;

    for (const [key, value] of webResponse.headers.entries()) {
        // We'll handle Set-Cookie separately if we have structured values.
        if (key.toLowerCase() === 'set-cookie' && setCookies?.length) continue;
        res.setHeader(key, value);
    }

    if (setCookies?.length) {
        res.setHeader('set-cookie', setCookies);
    }

    // Node requires writing headers before streaming body.
    res.flushHeaders?.();

    if (!webResponse.body) {
        res.end();
        return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
        const readable = Readable.fromWeb(webResponse.body as unknown as ReadableStream);
        readable.on('error', err => {
            try {
                res.destroy(err as Error);
            } catch {
                // ignore
            }
            reject(err);
        });
        res.on('error', reject);
        res.on('close', () => {
            try {
                readable.destroy();
            } catch {
                // ignore
            }
        });
        readable.pipe(res);
        res.on('finish', () => resolve());
    });
}

/**
 * Server transport for Streamable HTTP: this implements the MCP Streamable HTTP transport specification.
 * It supports both SSE streaming and direct HTTP responses.
 *
 * This is a wrapper around `WebStandardStreamableHTTPServerTransport` that provides Node.js HTTP compatibility.
 * It converts between Node.js HTTP (IncomingMessage/ServerResponse) and Web Standard Request/Response.
 *
 * Usage example:
 *
 * ```typescript
 * // Stateful mode - server sets the session ID
 * const statefulTransport = new NodeStreamableHTTPServerTransport({
 *   sessionIdGenerator: () => randomUUID(),
 * });
 *
 * // Stateless mode - explicitly set session ID to undefined
 * const statelessTransport = new NodeStreamableHTTPServerTransport({
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
export class NodeStreamableHTTPServerTransport implements Transport {
    private _webStandardTransport: WebStandardStreamableHTTPServerTransport;

    constructor(options: NodeStreamableHTTPServerTransportOptions = {}) {
        this._webStandardTransport = new WebStandardStreamableHTTPServerTransport(options);
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
     * Starts the transport. This is required by the Transport interface but is a no-op
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
     * Handles an incoming HTTP request, whether GET or POST.
     *
     * This method converts Node.js HTTP objects to Web Standard Request/Response
     * and delegates to the underlying WebStandardStreamableHTTPServerTransport.
     *
     * @param req - Node.js IncomingMessage, optionally with auth property from middleware
     * @param res - Node.js ServerResponse
     * @param parsedBody - Optional pre-parsed body from body-parser middleware
     */
    async handleRequest(req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse, parsedBody?: unknown): Promise<void> {
        const authInfo = req.auth;
        const webRequest = await nodeToWebRequest(req, { parsedBody });
        const webResponse = await this._webStandardTransport.handleRequest(webRequest, {
            authInfo,
            parsedBody
        });
        await writeWebResponse(res, webResponse);
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
