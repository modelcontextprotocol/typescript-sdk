/**
 * Test wiring helpers.
 *
 * `wire(transport, makeServer, client)` connects a server (built per call by
 * `makeServer`) and a client over the named transport, returning an
 * `AsyncDisposable` for `await using` teardown. All wiring is in-process —
 * no real sockets, no child processes — except the legacy SSE transport, whose
 * server half requires Node req/res and therefore runs over a real loopback
 * HTTP listener on an ephemeral port.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';

import type { Client } from '../../../src/client/index.js';
import { SSEClientTransport } from '../../../src/client/sse.js';
import { StreamableHTTPClientTransport } from '../../../src/client/streamableHttp.js';
import { InMemoryTransport } from '../../../src/inMemory.js';
import type { Server } from '../../../src/server/index.js';
import type { McpServer } from '../../../src/server/mcp.js';
import { SSEServerTransport } from '../../../src/server/sse.js';
import { StdioServerTransport } from '../../../src/server/stdio.js';
import { WebStandardStreamableHTTPServerTransport, type EventStore } from '../../../src/server/webStandardStreamableHttp.js';
import { ReadBuffer, serializeMessage } from '../../../src/shared/stdio.js';
import type { JSONRPCMessage } from '../../../src/types.js';

import type { Transport } from '../types.js';

import { sniffTransport, type SnifferOptions } from './wire-sniffer.js';

export type ServerFactory = () => McpServer | Server;

export interface Wired extends AsyncDisposable {
    readonly fetch?: (url: URL | string, init?: RequestInit) => Promise<Response>;
    readonly url?: URL;
}

/**
 * The fourth argument controls the wire-format sniffer (see wire-sniffer.ts):
 * every message the client sends or receives is validated against the SDK's
 * spec-anchored Zod schemas. Tests that intentionally use vendor-extension
 * methods pass `{ allowCustomMethods: true }`; tests that deliberately put
 * malformed MCP on the wire pass `{ strictValidation: false }`.
 */
export async function wire(transport: Transport, makeServer: ServerFactory, client: Client, sniff: SnifferOptions = {}): Promise<Wired> {
    switch (transport) {
        case 'inMemory': {
            const server = makeServer();
            const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
            await server.connect(serverTx);
            await client.connect(sniffTransport(clientTx, 'client', sniff));
            return { [Symbol.asyncDispose]: () => Promise.all([client.close(), server.close()]).then(() => {}) };
        }
        case 'stdio': {
            const server = makeServer();
            const c2s = new PassThrough();
            const s2c = new PassThrough();
            await server.connect(new StdioServerTransport(c2s, s2c));
            await client.connect(sniffTransport(stdioClientOverPipes(s2c, c2s), 'client', sniff));
            return { [Symbol.asyncDispose]: () => Promise.all([client.close(), server.close()]).then(() => {}) };
        }
        case 'streamableHttp':
        case 'streamableHttpStateless': {
            const handle = transport === 'streamableHttpStateless' ? hostStateless(makeServer) : hostPerSession(makeServer);
            const url = new URL('http://in-process/mcp');
            const fetch = (u: URL | string, init?: RequestInit) => handle.handleRequest(new Request(u, init));
            await client.connect(sniffTransport(new StreamableHTTPClientTransport(url, { fetch }), 'client', sniff));
            return {
                fetch,
                url,
                [Symbol.asyncDispose]: () => Promise.all([client.close(), handle.close()]).then(() => {})
            };
        }
        case 'sse': {
            // The legacy SSE server transport writes to a Node ServerResponse, so this branch hosts it
            // on a real loopback listener: GET /sse opens the stream (one server instance per
            // connection, mirroring hostPerSession) and POST /messages?sessionId=… delivers messages.
            const sessions = new Map<string, { tx: SSEServerTransport; server: McpServer | Server }>();
            const handleSseRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
                const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
                if (req.method === 'GET' && reqUrl.pathname === '/sse') {
                    const tx = new SSEServerTransport('/messages', res);
                    const server = makeServer();
                    sessions.set(tx.sessionId, { tx, server });
                    tx.onclose = () => void sessions.delete(tx.sessionId);
                    await server.connect(tx);
                    return;
                }
                if (req.method === 'POST' && reqUrl.pathname === '/messages') {
                    const session = sessions.get(reqUrl.searchParams.get('sessionId') ?? '');
                    if (!session) {
                        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Session not found');
                        return;
                    }
                    await session.tx.handlePostMessage(req, res);
                    return;
                }
                res.writeHead(404).end();
            };
            const httpServer = createServer((req, res) => {
                handleSseRequest(req, res).catch(() => {
                    // Mirror the SDK's own SSE test harness: handler failures become a 500, not an unhandled rejection.
                    if (!res.headersSent) res.writeHead(500).end();
                });
            });
            await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
            const address = httpServer.address();
            if (address === null || typeof address === 'string') throw new Error('expected the SSE host to listen on a TCP port');
            const url = new URL(`http://127.0.0.1:${address.port}/sse`);
            await client.connect(sniffTransport(new SSEClientTransport(url), 'client', sniff));
            return {
                url,
                [Symbol.asyncDispose]: async () => {
                    await client.close();
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
    }
}

/**
 * Tap a connected client's transport so every JSON-RPC message crossing the
 * wire is recorded. `sent` = client→server, `received` = server→client.
 * Call after `wire()` so `client.transport` is set. The transport is
 * monkey-patched in place; teardown via `await using` on `wire()` discards it.
 */
export function tapWire(client: Client): { sent: JSONRPCMessage[]; received: JSONRPCMessage[] } {
    const tx = client.transport;
    if (!tx) throw new Error('tapWire: client not connected');
    const sent: JSONRPCMessage[] = [];
    const received: JSONRPCMessage[] = [];
    const origSend = tx.send.bind(tx);
    const origOnMessage = tx.onmessage;
    tx.send = async (m, opts) => {
        sent.push(m);
        return origSend(m, opts);
    };
    tx.onmessage = (m, extra) => {
        received.push(m);
        origOnMessage?.(m, extra);
    };
    return { sent, received };
}

// ───────────────────────────────────────────────────────────────────────────────
// HTTP hosting (the two production patterns)
// ───────────────────────────────────────────────────────────────────────────────

export type HttpHandler = (req: Request) => Promise<Response>;

export function hostPerSession(makeServer: ServerFactory): { handleRequest: HttpHandler; close(): Promise<void> } {
    const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
    return {
        handleRequest: async req => {
            const sid = req.headers.get('mcp-session-id') ?? undefined;
            const existing = sid ? sessions.get(sid) : undefined;
            if (existing) return existing.handleRequest(req);
            if (sid !== undefined) {
                // Mirror the SDK's documented hosting pattern: an unrecognized session id is
                // rejected at the app level, so the transport's own 404 is never reached.
                return new Response(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
                        id: null
                    }),
                    { status: 400, headers: { 'Content-Type': 'application/json' } }
                );
            }

            const tx = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: randomUUID,
                onsessioninitialized: id => void sessions.set(id, tx),
                onsessionclosed: id => void sessions.delete(id)
            });
            await makeServer().connect(tx);
            return tx.handleRequest(req);
        },
        close: async () => {
            for (const t of sessions.values()) await t.close();
            sessions.clear();
        }
    };
}

export interface ResumeHostOptions {
    eventStore: EventStore;
    retryInterval?: number;
}

export function hostResumable(makeServer: ServerFactory, opts: ResumeHostOptions): { handleRequest: HttpHandler; close(): Promise<void> } {
    const sessions = new Map<string, { tx: WebStandardStreamableHTTPServerTransport; server: McpServer | Server }>();

    return {
        handleRequest: async req => {
            const sid = req.headers.get('mcp-session-id') ?? undefined;
            const existing = sid ? sessions.get(sid) : undefined;
            if (existing) return existing.tx.handleRequest(req);

            const tx = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: randomUUID,
                eventStore: opts.eventStore,
                retryInterval: opts.retryInterval,
                onsessioninitialized: id => void sessions.set(id, { tx, server }),
                onsessionclosed: id => void sessions.delete(id)
            });
            const server = makeServer();
            await server.connect(tx);
            return tx.handleRequest(req);
        },
        close: async () => {
            for (const { tx, server } of sessions.values()) {
                await server.close();
                await tx.close();
            }
            sessions.clear();
        }
    };
}

export function hostStateless(makeServer: ServerFactory): { handleRequest: HttpHandler; close(): Promise<void> } {
    const cleanups: Array<() => Promise<void>> = [];
    return {
        handleRequest: async req => {
            if (req.method !== 'POST') {
                return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }), {
                    status: 405,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            const server = makeServer();
            const tx = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await server.connect(tx);
            cleanups.push(async () => {
                await server.close();
                await tx.close();
            });
            return tx.handleRequest(req);
        },
        close: async () => {
            for (const c of cleanups) await c();
        }
    };
}

// ───────────────────────────────────────────────────────────────────────────────
// In-process stdio client — TEST-ONLY
//
// Production stdio uses `StdioClientTransport`, which spawns a child process.
// This is the in-process equivalent for tests: same newline-framed JSON wire
// format (uses the SDK's `serializeMessage`/`ReadBuffer`), but over PassThrough
// streams instead of a spawned process. Tests that specifically exercise spawn,
// env, signals, or stderr must use the real `StdioClientTransport`.
// ───────────────────────────────────────────────────────────────────────────────

function stdioClientOverPipes(serverStdout: NodeJS.ReadableStream, serverStdin: NodeJS.WritableStream) {
    const buf = new ReadBuffer();
    return {
        onmessage: undefined as ((m: JSONRPCMessage) => void) | undefined,
        onerror: undefined as ((e: Error) => void) | undefined,
        onclose: undefined as (() => void) | undefined,
        async start() {
            serverStdout.on('data', chunk => {
                buf.append(chunk);
                let m: JSONRPCMessage | null;
                while ((m = buf.readMessage())) this.onmessage?.(m);
            });
            serverStdout.on('error', e => this.onerror?.(e));
            serverStdout.on('close', () => this.onclose?.());
        },
        async send(m: JSONRPCMessage) {
            serverStdin.write(serializeMessage(m));
        },
        async close() {
            serverStdin.end();
        }
    };
}
