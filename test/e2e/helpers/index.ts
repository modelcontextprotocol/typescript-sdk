/**
 * Test wiring helpers.
 *
 * `wire(transport, makeServer, client)` connects a server (built per call by
 * `makeServer`) and a client over the named transport, returning an
 * `AsyncDisposable` for `await using` teardown. All wiring is in-process —
 * no real sockets, no child processes — except the legacy SSE transport,
 * whose client half opens a real EventSource stream, so it runs over a
 * loopback HTTP listener hosting the shipped server-side SSE transport
 * (see sse-host.ts).
 */

import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';

import type { Client } from '@modelcontextprotocol/client';
import { SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { EventStore, JSONRPCMessage, McpServer, Server } from '@modelcontextprotocol/server';
import {
    DRAFT_PROTOCOL_VERSION,
    InMemoryTransport,
    ReadBuffer,
    serializeMessage,
    SUPPORTED_PROTOCOL_VERSIONS,
    WebStandardStreamableHTTPServerTransport
} from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import type { SpecVersion, Transport } from '../types.js';
import { startLegacySseHost } from './sse-host.js';
import type { SnifferOptions } from './wire-sniffer.js';
import { sniffTransport } from './wire-sniffer.js';

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
            // The legacy SSE transport needs a real socket: the factory's server is hosted on the
            // shipped SSEServerTransport (@modelcontextprotocol/server-legacy/sse) behind a loopback
            // listener, and the real shipped SSEClientTransport connects to it.
            const host = await startLegacySseHost(makeServer);
            await client.connect(sniffTransport(new SSEClientTransport(host.url), 'client', sniff));
            return {
                url: host.url,
                [Symbol.asyncDispose]: async () => {
                    await client.close();
                    await host.close();
                }
            };
        }
    }
}

/**
 * The per-cell force-version knob: the `supportedProtocolVersions` list that pins a
 * client/server pair to the given spec version. `'2026-07-28'` returns only the draft
 * revision, so the pair can only meet on the per-request era (no initialize fallback);
 * `'2025-11-25'` returns the SDK default list (initialize-era negotiation).
 */
export function protocolVersionsFor(specVersion: SpecVersion): string[] {
    return specVersion === '2026-07-28' ? [DRAFT_PROTOCOL_VERSION] : [...SUPPORTED_PROTOCOL_VERSIONS];
}

export interface ConnectTapEntry {
    direction: 'client-to-server' | 'server-to-client';
    message: JSONRPCMessage;
}

/**
 * Patch `client.connect` so the transport `wire()` hands it is tapped from the very
 * first message — {@link tapWire} can only attach after connect, too late to observe
 * the version-negotiation traffic (discover probe / initialize handshake). The tap
 * stays attached for the connection's lifetime, so post-connect requests are recorded
 * too. Call before `wire()`.
 */
export function tapConnect(client: Client): ConnectTapEntry[] {
    const log: ConnectTapEntry[] = [];
    const originalConnect = client.connect.bind(client);
    client.connect = (clientTransport, options) => {
        const originalSend = clientTransport.send.bind(clientTransport);
        clientTransport.send = (message, sendOptions) => {
            log.push({ direction: 'client-to-server', message });
            return originalSend(message, sendOptions);
        };
        // Protocol.connect chains a pre-set onmessage, so inbound messages are logged before the client reacts to them.
        clientTransport.onmessage = message => {
            log.push({ direction: 'server-to-client', message });
        };
        return originalConnect(clientTransport, options);
    };
    return log;
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
                return Response.json(
                    {
                        jsonrpc: '2.0',
                        error: { code: -32_000, message: 'Bad Request: No valid session ID provided' },
                        id: null
                    },
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
                return Response.json(
                    { jsonrpc: '2.0', error: { code: -32_000, message: 'Method not allowed.' }, id: null },
                    {
                        status: 405,
                        headers: { 'Content-Type': 'application/json' }
                    }
                );
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
// Exported for bodies that wire stdio without `wire()` (e.g. connect-failure
// cases, where `wire()` would leak its half-built host on the throw).
// ───────────────────────────────────────────────────────────────────────────────

export function stdioClientOverPipes(serverStdout: NodeJS.ReadableStream, serverStdin: NodeJS.WritableStream) {
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
