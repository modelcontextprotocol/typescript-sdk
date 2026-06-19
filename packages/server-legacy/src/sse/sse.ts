import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TLSSocket } from 'node:tls';

import type { AuthInfo, JSONRPCMessage, MessageExtraInfo, Transport, TransportSendOptions } from '@modelcontextprotocol/core';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/core';
import contentType from 'content-type';
import getRawBody from 'raw-body';

const MAXIMUM_MESSAGE_SIZE = '4mb';

/**
 * Configuration options for SSEServerTransport.
 * @deprecated Use StreamableHTTPServerTransport instead.
 */
export interface SSEServerTransportOptions {
    /**
     * @deprecated Use the host-header-validation middleware from @modelcontextprotocol/express instead.
     */
    allowedHosts?: string[];

    /**
     * @deprecated Use the host-header-validation middleware from @modelcontextprotocol/express instead.
     */
    allowedOrigins?: string[];

    /**
     * @deprecated Use the host-header-validation middleware from @modelcontextprotocol/express instead.
     */
    enableDnsRebindingProtection?: boolean;
}

/**
 * Server transport for SSE: this will send messages over an SSE connection and receive messages from HTTP POST requests.
 *
 * This transport is only available in Node.js environments.
 * @deprecated Use StreamableHTTPServerTransport from @modelcontextprotocol/server instead.
 */
export class SSEServerTransport implements Transport {
    private _sseResponse?: ServerResponse;
    private _sessionId: string;
    private _options: SSEServerTransportOptions;
    onclose?: () => void;
    onerror?: ((error: Error) => void) | undefined;
    onmessage?: (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void) | undefined;

    constructor(
        private _endpoint: string,
        private res: ServerResponse,
        options?: SSEServerTransportOptions
    ) {
        this._sessionId = randomUUID();
        this._options = options || { enableDnsRebindingProtection: false };
    }

    private validateRequestHeaders(req: IncomingMessage): string | undefined {
        if (!this._options.enableDnsRebindingProtection) {
            return undefined;
        }

        if (this._options.allowedHosts && this._options.allowedHosts.length > 0) {
            const hostHeader = req.headers.host;
            if (!hostHeader || !this._options.allowedHosts.includes(hostHeader)) {
                return `Invalid Host header: ${hostHeader}`;
            }
        }

        if (this._options.allowedOrigins && this._options.allowedOrigins.length > 0) {
            const originHeader = req.headers.origin;
            if (originHeader && !this._options.allowedOrigins.includes(originHeader)) {
                return `Invalid Origin header: ${originHeader}`;
            }
        }

        return undefined;
    }

    async start(): Promise<void> {
        if (this._sseResponse) {
            throw new Error('SSEServerTransport already started! If using Server class, note that connect() calls start() automatically.');
        }

        this.res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive'
        });

        const dummyBase = 'http://localhost';
        const endpointUrl = new URL(this._endpoint, dummyBase);
        endpointUrl.searchParams.set('sessionId', this._sessionId);

        const relativeUrlWithSession = endpointUrl.pathname + endpointUrl.search + endpointUrl.hash;

        this.res.write(`event: endpoint\ndata: ${relativeUrlWithSession}\n\n`);

        this._sseResponse = this.res;
        this.res.on('close', () => {
            this._sseResponse = undefined;
            this.onclose?.();
        });
    }

    async handlePostMessage(req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse, parsedBody?: unknown): Promise<void> {
        if (!this._sseResponse) {
            const message = 'SSE connection not established';
            res.writeHead(500).end(message);
            throw new Error(message);
        }

        const validationError = this.validateRequestHeaders(req);
        if (validationError) {
            res.writeHead(403).end(validationError);
            this.onerror?.(new Error(validationError));
            return;
        }

        const authInfo: AuthInfo | undefined = req.auth;

        const host = req.headers.host;
        const protocol = req.socket instanceof TLSSocket ? 'https' : 'http';
        const fullUrl = host && req.url ? new URL(req.url, `${protocol}://${host}`) : undefined;

        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') {
                headers.set(key, value);
            } else if (Array.isArray(value)) {
                for (const v of value) {
                    headers.append(key, v);
                }
            }
        }

        const request = fullUrl ? new Request(fullUrl.toString(), { method: req.method ?? 'POST', headers }) : undefined;

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

    async handleMessage(message: unknown, extra?: MessageExtraInfo): Promise<void> {
        let parsedMessage: JSONRPCMessage;
        try {
            parsedMessage = JSONRPCMessageSchema.parse(message);
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

    async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
        if (!this._sseResponse) {
            throw new Error('Not connected');
        }

        this._sseResponse.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    }

    get sessionId(): string {
        return this._sessionId;
    }
}
