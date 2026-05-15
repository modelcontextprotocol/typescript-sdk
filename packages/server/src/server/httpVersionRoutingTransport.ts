import type { AuthInfo, JSONRPCMessage, ProtocolConfig, ServerCapabilities, Transport } from '@modelcontextprotocol/core';
import { isJSONRPCRequest, JSONRPCMessageSchema, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/core';

import { ModernProtocolHandler } from './modernHandler.js';
import { LegacyServer } from './server.js';
import type { HandleRequestOptions, WebStandardStreamableHTTPServerTransportOptions } from './streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from './streamableHttp.js';

interface LegacySessionEntry {
    transport: WebStandardStreamableHTTPServerTransport;
    server: LegacyServer;
}

export interface HTTPVersionRoutingTransportOptions {
    sessionIdGenerator?: () => string;
}

export class HTTPVersionRoutingTransport implements Transport {
    onmessage?: Transport['onmessage'];
    onclose?: Transport['onclose'];
    onerror?: Transport['onerror'];
    sessionId?: string;

    private protocolConfig?: ProtocolConfig;
    private modernHandler?: ModernProtocolHandler;
    private legacySessions = new Map<string, LegacySessionEntry>();
    private options: HTTPVersionRoutingTransportOptions;

    constructor(options?: HTTPVersionRoutingTransportOptions) {
        this.options = options ?? {};
    }

    setProtocolConfig(config: ProtocolConfig): void {
        this.protocolConfig = config;
        this.modernHandler = new ModernProtocolHandler({
            requestHandlers: config.requestHandlers,
            serverInfo: config.serverInfo!,
            capabilities: config.capabilities!,
            instructions: config.instructions
        });
    }

    async start(): Promise<void> {
        // Nothing to do — we handle requests on demand
    }

    async close(): Promise<void> {
        for (const [id, entry] of this.legacySessions) {
            await entry.server.close();
            this.legacySessions.delete(id);
        }
    }

    async send(_message: JSONRPCMessage): Promise<void> {
        throw new Error(
            'HTTPVersionRoutingTransport.send() should never be called. ' +
                'All dispatch goes through ModernProtocolHandler or per-session legacy transports.'
        );
    }

    async handleRequest(req: Request, options?: HandleRequestOptions): Promise<Response> {
        return this.isStatelessProtocolRequest(req) ? this.handleModernRequest(req, options) : this.handleLegacyRequest(req, options);
    }

    private isStatelessProtocolRequest(req: Request): boolean {
        return req.headers.has('mcp-method');
    }

    private async handleModernRequest(req: Request, options?: HandleRequestOptions): Promise<Response> {
        if (!this.modernHandler) {
            return this.jsonErrorResponse(500, ProtocolErrorCode.InternalError, 'Modern handler not initialized');
        }

        if (req.method !== 'POST') {
            return new Response(null, { status: 405, headers: { Allow: 'POST' } });
        }

        const ct = req.headers.get('content-type');
        if (!ct || !ct.includes('application/json')) {
            return this.jsonErrorResponse(415, -32_000, 'Unsupported Media Type: expected application/json');
        }

        let rawMessage: unknown;
        if (options?.parsedBody === undefined) {
            try {
                rawMessage = await req.json();
            } catch {
                return this.jsonErrorResponse(400, -32_700, 'Parse error: Invalid JSON');
            }
        } else {
            rawMessage = options.parsedBody;
        }

        if (Array.isArray(rawMessage)) {
            return this.jsonErrorResponse(400, -32_600, 'Batch requests not supported on 2026-06 path');
        }

        let message;
        try {
            message = JSONRPCMessageSchema.parse(rawMessage);
        } catch {
            return this.jsonErrorResponse(400, -32_700, 'Parse error: Invalid JSON-RPC message');
        }

        if (!isJSONRPCRequest(message)) {
            return this.jsonErrorResponse(400, -32_600, 'Expected JSON-RPC request');
        }

        const authInfo: AuthInfo | undefined = options?.authInfo;
        const response = await this.modernHandler.handleRequest(message, {
            authInfo,
            request: req
        });

        return Response.json(response, {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    private async handleLegacyRequest(req: Request, options?: HandleRequestOptions): Promise<Response> {
        const sessionId = req.headers.get('mcp-session-id');

        if (sessionId) {
            const entry = this.legacySessions.get(sessionId);
            if (!entry) {
                return this.jsonErrorResponse(404, -32_000, 'Session not found');
            }
            return entry.transport.handleRequest(req, options);
        }

        if (req.method === 'POST') {
            return this.handleLegacyInitialize(req, options);
        }

        return this.jsonErrorResponse(400, -32_600, 'Missing Mcp-Session-Id header');
    }

    private async handleLegacyInitialize(req: Request, options?: HandleRequestOptions): Promise<Response> {
        const innerServer = this.protocolConfig!.createServer
            ? (this.protocolConfig!.createServer() as LegacyServer)
            : new LegacyServer(this.protocolConfig!.serverInfo!, {
                  capabilities: this.protocolConfig!.capabilities as ServerCapabilities,
                  instructions: this.protocolConfig!.instructions
              });

        innerServer.fallbackRequestHandler = async (request, ctx) => {
            const handler = this.protocolConfig!.requestHandlers.get(request.method);
            if (!handler) {
                throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Method not found: ${request.method}`);
            }
            return handler(request, ctx);
        };

        const transportOptions: WebStandardStreamableHTTPServerTransportOptions = {
            sessionIdGenerator: this.options.sessionIdGenerator ?? (() => crypto.randomUUID()),
            onsessioninitialized: (sid: string) => {
                this.legacySessions.set(sid, { transport: innerTransport, server: innerServer });
            }
        };

        const innerTransport = new WebStandardStreamableHTTPServerTransport(transportOptions);

        innerTransport.onclose = () => {
            const sid = innerTransport.sessionId;
            if (sid) this.legacySessions.delete(sid);
        };

        await innerServer.connect(innerTransport);
        return innerTransport.handleRequest(req, options);
    }

    private jsonErrorResponse(httpStatus: number, code: number, message: string): Response {
        return Response.json(
            {
                jsonrpc: '2.0',
                error: { code, message },
                id: null
            },
            {
                status: httpStatus,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}
