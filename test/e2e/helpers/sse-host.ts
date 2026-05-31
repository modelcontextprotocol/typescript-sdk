/**
 * Test-only legacy HTTP+SSE host bridge.
 *
 * v2 removed the server-side SSE transport, but the client-side
 * SSEClientTransport is still shipped for talking to legacy servers. This
 * bridge stands in for the removed server half so the e2e matrix can exercise
 * the real client transport end to end: it speaks the legacy wire protocol
 * (an `endpoint` SSE event carrying the POST URL with the sessionId,
 * `message` SSE events for server→client JSON-RPC, plain POSTs for
 * client→server JSON-RPC) over a real loopback listener and bridges to a real
 * v2 server through the Transport interface.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';

import { JSONRPCMessageSchema } from '@modelcontextprotocol/core';
import type { JSONRPCMessage, McpServer, Server, Transport } from '@modelcontextprotocol/server';

const SSE_PATH = '/sse';
const POST_PATH = '/messages';

type AnyServer = McpServer | Server;

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

/** Test-only server half of the legacy HTTP+SSE transport (v2 ships only the client half). */
export class LegacySseServerTransport implements Transport {
    private _response?: ServerResponse;
    readonly sessionId: string = randomUUID();

    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    constructor(private readonly _res: ServerResponse) {}

    async start(): Promise<void> {
        if (this._response) throw new Error('LegacySseServerTransport already started');
        this._res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive'
        });
        // The legacy protocol's first event tells the client where to POST its messages.
        this._res.write(`event: endpoint\ndata: ${POST_PATH}?sessionId=${this.sessionId}\n\n`);
        this._response = this._res;
        this._res.on('close', () => {
            this._response = undefined;
            this.onclose?.();
        });
    }

    async send(message: JSONRPCMessage): Promise<void> {
        if (!this._response) throw new Error('SSE stream not established');
        this._response.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    }

    async close(): Promise<void> {
        this._response?.end();
        this._response = undefined;
        this.onclose?.();
    }

    /** Delivers a client→server POST to the server side and answers the HTTP request (202 on success). */
    async handlePostMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!this._response) {
            res.writeHead(500).end('SSE connection not established');
            return;
        }
        const contentTypeHeader = req.headers['content-type'] ?? '';
        if (!contentTypeHeader.includes('application/json')) {
            res.writeHead(400).end(`Unsupported content-type: ${contentTypeHeader}`);
            return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        const raw = Buffer.concat(chunks).toString('utf8');

        let message: JSONRPCMessage;
        try {
            message = JSONRPCMessageSchema.parse(JSON.parse(raw));
        } catch (error) {
            res.writeHead(400).end(`Invalid message: ${raw}`);
            this.onerror?.(toError(error));
            return;
        }
        res.writeHead(202).end('Accepted');
        this.onmessage?.(message);
    }
}

export interface LegacySseHost {
    /** URL of the SSE endpoint; GET it to open a stream. */
    readonly url: URL;
    close(): Promise<void>;
}

/**
 * Runs a loopback legacy-SSE host: every GET on the SSE path gets its own
 * server instance from the factory (mirroring hostPerSession), POSTs are
 * routed to the owning session, unknown sessions get 404 and handler failures
 * become 500.
 */
export async function startLegacySseHost(makeServer: () => AnyServer): Promise<LegacySseHost> {
    const sessions = new Map<string, { tx: LegacySseServerTransport; server: AnyServer }>();

    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method === 'GET' && requestUrl.pathname === SSE_PATH) {
            const tx = new LegacySseServerTransport(res);
            const server = makeServer();
            sessions.set(tx.sessionId, { tx, server });
            // connect() starts the transport, which writes the SSE headers and the endpoint event.
            await server.connect(tx);
            return;
        }
        if (req.method === 'POST' && requestUrl.pathname === POST_PATH) {
            const session = sessions.get(requestUrl.searchParams.get('sessionId') ?? '');
            if (!session) {
                res.writeHead(404, { 'content-type': 'text/plain' }).end('Session not found');
                return;
            }
            await session.tx.handlePostMessage(req, res);
            return;
        }
        res.writeHead(404).end();
    };

    const httpServer = createServer((req, res) => {
        handle(req, res).catch((error: unknown) => {
            // Handler failures become a 500 rather than an unhandled rejection.
            if (!res.headersSent) res.writeHead(500).end(toError(error).message);
        });
    });

    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (address === null || typeof address === 'string') throw new Error('expected the SSE host to listen on a TCP port');
    const url = new URL(`http://127.0.0.1:${address.port}${SSE_PATH}`);

    return {
        url,
        close: async () => {
            for (const { tx, server } of sessions.values()) {
                await server.close();
                await tx.close();
            }
            sessions.clear();
            httpServer.closeAllConnections();
            await new Promise<void>(resolve => httpServer.close(() => resolve()));
        }
    };
}
