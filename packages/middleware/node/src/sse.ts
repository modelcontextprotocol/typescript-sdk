/**
 * Legacy SSE Server Transport (v1 compatibility shim)
 *
 * This module restores the v1 `SSEServerTransport` class for backwards
 * compatibility. It is a frozen port of the v1 implementation with imports
 * adapted to the v2 package layout. New code should use
 * `NodeStreamableHTTPServerTransport` from `@modelcontextprotocol/node`
 * instead.
 *
 * @module sse
 * @deprecated Use `NodeStreamableHTTPServerTransport` instead.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';

import type { AuthInfo, JSONRPCMessage, MessageExtraInfo, Transport } from '@modelcontextprotocol/core';
import { parseJSONRPCMessage } from '@modelcontextprotocol/server';
import contentType from 'content-type';
import getRawBody from 'raw-body';

const MAXIMUM_MESSAGE_SIZE = '4mb';

/**
 * Configuration options for `SSEServerTransport`.
 *
 * @deprecated Use `NodeStreamableHTTPServerTransport` from `@modelcontextprotocol/node` instead.
 */
export interface SSEServerTransportOptions {
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
     * Default is `false` for backwards compatibility.
     */
    enableDnsRebindingProtection?: boolean;
}

/**
 * Server transport for the legacy HTTP+SSE protocol: sends messages over an SSE
 * connection and receives messages from separate HTTP POST requests.
 *
 * This transport is only available in Node.js environments.
 *
 * @deprecated Use `NodeStreamableHTTPServerTransport` from `@modelcontextprotocol/node` instead.
 */
export class SSEServerTransport implements Transport {
    private _sseResponse?: ServerResponse;
    private _sessionId: string;
    private _options: SSEServerTransportOptions;

    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

    /**
     * Creates a new SSE server transport, which will direct the client to POST
     * messages to the relative or absolute URL identified by `endpoint`.
     */
    constructor(
        private _endpoint: string,
        private res: ServerResponse,
        options?: SSEServerTransportOptions
    ) {
        this._sessionId = randomUUID();
        this._options = options ?? { enableDnsRebindingProtection: false };
    }

    /**
     * Validates request headers for DNS rebinding protection.
     * @returns Error message if validation fails, undefined if validation passes.
     */
    private validateRequestHeaders(req: IncomingMessage): string | undefined {
        // Skip validation if protection is not enabled
        if (!this._options.enableDnsRebindingProtection) {
            return undefined;
        }

        // Validate Host header if allowedHosts is configured
        if (this._options.allowedHosts && this._options.allowedHosts.length > 0) {
            const hostHeader = req.headers.host;
            if (!hostHeader || !this._options.allowedHosts.includes(hostHeader)) {
                return `Invalid Host header: ${hostHeader}`;
            }
        }

        // Validate Origin header if allowedOrigins is configured
        if (this._options.allowedOrigins && this._options.allowedOrigins.length > 0) {
            const originHeader = req.headers.origin;
            if (originHeader && !this._options.allowedOrigins.includes(originHeader)) {
                return `Invalid Origin header: ${originHeader}`;
            }
        }

        return undefined;
    }

    /**
     * Handles the initial SSE connection request.
     *
     * This should be called when a GET request is made to establish the SSE stream.
     */
    async start(): Promise<void> {
        if (this._sseResponse) {
            throw new Error('SSEServerTransport already started! If using Server class, note that connect() calls start() automatically.');
        }

        this.res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive'
        });

        // Send the endpoint event.
        // Use a dummy base URL because this._endpoint is relative.
        // This allows using URL/URLSearchParams for robust parameter handling.
        const dummyBase = 'http://localhost'; // Any valid base works
        const endpointUrl = new URL(this._endpoint, dummyBase);
        endpointUrl.searchParams.set('sessionId', this._sessionId);

        // Reconstruct the relative URL string (pathname + search + hash)
        const relativeUrlWithSession = endpointUrl.pathname + endpointUrl.search + endpointUrl.hash;

        this.res.write(`event: endpoint\ndata: ${relativeUrlWithSession}\n\n`);

        this._sseResponse = this.res;
        this.res.on('close', () => {
            this._sseResponse = undefined;
            this.onclose?.();
        });
    }

    /**
     * Handles incoming POST messages.
     *
     * This should be called when a POST request is made to send a message to the server.
     */
    async handlePostMessage(req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse, parsedBody?: unknown): Promise<void> {
        if (!this._sseResponse) {
            const message = 'SSE connection not established';
            res.writeHead(500).end(message);
            throw new Error(message);
        }

        // Validate request headers for DNS rebinding protection
        const validationError = this.validateRequestHeaders(req);
        if (validationError) {
            res.writeHead(403).end(validationError);
            this.onerror?.(new Error(validationError));
            return;
        }

        const authInfo: AuthInfo | undefined = req.auth;
        const request = toWebRequest(req);

        let body: string | unknown;
        try {
            const ct = contentType.parse(req.headers['content-type'] ?? '');
            if (ct.type !== 'application/json') {
                throw new Error(`Unsupported content-type: ${ct.type}`);
            }

            body =
                parsedBody ??
                (await getRawBody(req, {
                    limit: MAXIMUM_MESSAGE_SIZE,
                    encoding: ct.parameters.charset ?? 'utf8'
                }));
        } catch (error) {
            res.writeHead(400).end(String(error));
            this.onerror?.(error as Error);
            return;
        }

        try {
            await this.handleMessage(typeof body === 'string' ? JSON.parse(body) : body, { request, authInfo });
        } catch {
            res.writeHead(400).end(`Invalid message: ${body}`);
            return;
        }

        res.writeHead(202).end('Accepted');
    }

    /**
     * Handle a client message, regardless of how it arrived. This can be used to
     * inform the server of messages that arrive via a means different than HTTP POST.
     */
    async handleMessage(message: unknown, extra?: MessageExtraInfo): Promise<void> {
        let parsedMessage: JSONRPCMessage;
        try {
            parsedMessage = parseJSONRPCMessage(message);
        } catch (error) {
            this.onerror?.(error as Error);
            throw error;
        }

        this.onmessage?.(parsedMessage, extra);
    }

    async close(): Promise<void> {
        this._sseResponse?.end();
        this._sseResponse = undefined;
        this.onclose?.();
    }

    async send(message: JSONRPCMessage): Promise<void> {
        if (!this._sseResponse) {
            throw new Error('Not connected');
        }

        this._sseResponse.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    }

    /**
     * Returns the session ID for this transport.
     *
     * This can be used to route incoming POST requests.
     */
    get sessionId(): string {
        return this._sessionId;
    }
}

/**
 * Builds a Web-standard {@linkcode Request} (URL + headers only) from a Node
 * {@linkcode IncomingMessage} so v2 handler contexts can read `extra.request`.
 * The body is omitted because the transport consumes it separately.
 */
function toWebRequest(req: IncomingMessage): globalThis.Request | undefined {
    const host = req.headers.host;
    if (!host || !req.url) {
        return undefined;
    }
    // We can't reliably detect TLS at this layer (proxies, etc.); the scheme is
    // best-effort and only matters for handler-side URL inspection.
    const isEncrypted = (req.socket as { encrypted?: boolean } | undefined)?.encrypted === true;
    const protocol = isEncrypted ? 'https' : 'http';
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    return new Request(new URL(req.url, `${protocol}://${host}`), {
        method: req.method,
        headers
    });
}
