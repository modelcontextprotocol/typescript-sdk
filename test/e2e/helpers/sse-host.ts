/**
 * Legacy HTTP+SSE host.
 *
 * Hosts the SDK's shipped server-side SSE transport (`SSEServerTransport` from
 * `@modelcontextprotocol/server-legacy/sse`) on a real loopback listener so the
 * e2e matrix exercises both shipped halves of the legacy transport end to end:
 * GET opens the SSE stream (an `endpoint` event carries the POST URL with the
 * sessionId), POSTs deliver client→server JSON-RPC to the owning session.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';

import type { McpServer, Server } from '@modelcontextprotocol/server';
import { SSEServerTransport } from '@modelcontextprotocol/server-legacy/sse';

const SSE_PATH = '/sse';
const POST_PATH = '/messages';

type AnyServer = McpServer | Server;

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
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
    const sessions = new Map<string, { tx: SSEServerTransport; server: AnyServer }>();

    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method === 'GET' && requestUrl.pathname === SSE_PATH) {
            const tx = new SSEServerTransport(POST_PATH, res);
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
