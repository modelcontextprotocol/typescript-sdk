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
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/core';
import type {
    CreateMcpHandlerOptions,
    EventStore,
    Implementation,
    JSONRPCMessage,
    McpRequestContext,
    McpServer,
    Server,
    Transport as SdkTransport
} from '@modelcontextprotocol/server';
import {
    createMcpHandler,
    InMemoryTransport,
    ReadBuffer,
    serializeMessage,
    WebStandardStreamableHTTPServerTransport
} from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import type { SpecVersion, Transport } from '../types.js';
import { startLegacySseHost } from './sse-host.js';
import type { SnifferOptions } from './wire-sniffer.js';
import { sniffTransport } from './wire-sniffer.js';

export type ServerFactory = () => McpServer | Server;

/**
 * A factory that optionally consumes the createMcpHandler per-request context.
 * The context is only supplied on the entry arms (where the entry constructs a
 * fresh instance per request); on every other arm the factory is called with no
 * arguments, so declare the parameter optional.
 */
export type EntryServerFactory = (ctx?: McpRequestContext) => McpServer | Server;

/** One HTTP exchange recorded by the entry arms (see {@linkcode Wired.httpLog}). */
export interface RecordedHttpExchange {
    /** HTTP request method (GET/POST/DELETE). */
    method: string;
    /** The request body text, when one was sent as a string. */
    requestBody?: string;
    /** HTTP response status. */
    status: number;
    /** Response content-type header (empty string when absent). */
    contentType: string;
    /** An unread clone of the HTTP response, for byte-level assertions (`await exchange.response.text()`). */
    response: Response;
}

export interface Wired extends AsyncDisposable {
    readonly fetch?: (url: URL | string, init?: RequestInit) => Promise<Response>;
    readonly url?: URL;
    /**
     * Every HTTP exchange the wired client performed, in order, including the
     * connect-time negotiation. Recorded by the createMcpHandler entry arms
     * only — scenarios on those arms use it to assert raw wire facts (request
     * bodies, response status/content-type/bytes) that the typed client API
     * does not expose.
     */
    readonly httpLog?: readonly RecordedHttpExchange[];
}

/**
 * The fourth argument's sniffer options control the wire-format sniffer (see
 * wire-sniffer.ts): every message the client sends or receives is validated
 * against the SDK's spec-anchored Zod schemas. Tests that intentionally use
 * vendor-extension methods pass `{ allowCustomMethods: true }`; tests that
 * deliberately put malformed MCP on the wire pass `{ strictValidation: false }`.
 * `entry` overrides the hosting options of the createMcpHandler entry arms
 * (ignored by every other transport).
 */
export interface WireOptions extends SnifferOptions {
    /**
     * createMcpHandler hosting overrides for the entry arms. Defaults:
     * `{ legacy: 'stateless' }` on entryStateless (the canonical slot value) and
     * modern-only strict (no legacy slot) on entryModern. `onerror` and
     * `responseMode` pass through unchanged.
     */
    entry?: CreateMcpHandlerOptions;
}

export async function wire(
    transport: Transport,
    makeServer: ServerFactory | EntryServerFactory,
    client: Client,
    sniff: WireOptions = {}
): Promise<Wired> {
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
        case 'entryStateless':
        case 'entryModern': {
            // The dual-era HTTP entry (`createMcpHandler`) hosted in process via an
            // injected fetch, exactly like the other HTTP arms. The scenario factory
            // backs the entry directly (the entry calls it once per request with its
            // per-request context). `entryStateless` serves the scenario's plain
            // client through the entry's `legacy: 'stateless'` slot; `entryModern`
            // keeps the endpoint modern-only strict and connects the client on the
            // 2026-07-28 revision (pin-mode negotiation + the per-request envelope
            // stop-gap). Every HTTP exchange is recorded on `httpLog`.
            const handler = createMcpHandler(
                makeServer,
                transport === 'entryStateless' ? { legacy: 'stateless', ...sniff.entry } : { ...sniff.entry }
            );
            const url = new URL('http://in-process/mcp');
            const httpLog: RecordedHttpExchange[] = [];
            const fetch = async (u: URL | string, init?: RequestInit) => {
                const request = new Request(u, init);
                const response = await handler.fetch(request);
                httpLog.push({
                    method: request.method.toUpperCase(),
                    ...(typeof init?.body === 'string' && { requestBody: init.body }),
                    status: response.status,
                    contentType: response.headers.get('content-type') ?? '',
                    response: response.clone()
                });
                return response;
            };
            let clientTx = new StreamableHTTPClientTransport(url, { fetch });
            if (transport === 'entryModern') {
                pinModernNegotiation(client);
                clientTx = attachModernEnvelope(clientTx);
            }
            await client.connect(sniffTransport(clientTx, 'client', sniff));
            if (transport === 'entryModern') assertModernNegotiation(client);
            return {
                fetch,
                url,
                httpLog,
                [Symbol.asyncDispose]: () => Promise.all([client.close(), handler.close()]).then(() => {})
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
// createMcpHandler entry arms (entryStateless / entryModern) — client-side shims
// ───────────────────────────────────────────────────────────────────────────────

/** The protocol revision the entryModern arm negotiates and claims per request. */
const MODERN_REVISION: SpecVersion = '2026-07-28';

/**
 * The per-request `_meta` envelope of a 2026-07-28 request, for scenario bodies
 * that put raw HTTP requests on the wire (via `wired.fetch`) rather than going
 * through the wired client. Typed calls through the wired client never need
 * this — the entryModern arm attaches the envelope itself (see
 * {@linkcode attachModernEnvelope}).
 */
export function modernEnvelopeMeta(clientInfo?: Implementation): Record<string, unknown> {
    return {
        [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
        [CLIENT_INFO_META_KEY]: clientInfo ?? { name: 'e2e-entry-client', version: '1.0.0' },
        [CLIENT_CAPABILITIES_META_KEY]: {}
    };
}

/**
 * Put the (already constructed) scenario client into pinned 2026-07-28
 * negotiation. Version negotiation is a constructor-only option and the
 * scenario corpus constructs era-agnostic clients, so the entryModern arm flips
 * the option on the instance before `connect()` — a harness stop-gap, not a
 * public API. Clients that already opted into a negotiation mode are left
 * untouched (their cells deliberately exercise that mode).
 */
function pinModernNegotiation(client: Client): void {
    const internals = client as unknown as { _versionNegotiation?: { mode?: unknown } };
    internals._versionNegotiation ??= { mode: { pin: MODERN_REVISION } };
}

/**
 * Fail fast if an entryModern connection did not actually negotiate the
 * 2026-07-28 revision. Every cell on the arm asserts modern-path behavior, so
 * a broken negotiation pin (or a regression in the discover negotiation) would
 * otherwise surface as hundreds of unrelated downstream assertion failures;
 * this turns it into one attributable arm-level error right after connect.
 */
function assertModernNegotiation(client: Client): void {
    const negotiated = client.getNegotiatedProtocolVersion();
    if (negotiated !== MODERN_REVISION) {
        throw new Error(
            `entryModern arm: expected the connection to negotiate protocol version ${MODERN_REVISION}, but it negotiated ${negotiated ?? 'no version'}`
        );
    }
}

/**
 * The per-request `_meta` envelope stop-gap for the entryModern arm: the
 * negotiating client only attaches the envelope to its `server/discover` probe
 * today (automatic per-request emission is a client-side follow-up), so the
 * harness re-attaches the same envelope to every later request and notification
 * the scenario's typed calls put on the wire. The envelope is captured from the
 * latest enveloped message the client sent (normally the probe), so it always
 * matches the most recent claim the client actually made — a connection that
 * renegotiated would not keep stamping a stale version; messages that already
 * carry a protocol-version claim (the probe, or a scenario's explicitly
 * enveloped request) pass through untouched.
 *
 * Applied beneath the wire sniffer and `tapWire`, so recorded traffic shows the
 * messages exactly as the scenario sent them while the wire carries the
 * envelope the entry requires.
 */
function attachModernEnvelope<T extends SdkTransport>(transport: T): T {
    let envelope: Record<string, unknown> | undefined;
    const origSend = transport.send.bind(transport);
    transport.send = async (message, opts) => {
        let outbound = message;
        if ('method' in message) {
            const params = (message.params ?? {}) as { _meta?: Record<string, unknown> };
            const meta = params._meta;
            if (meta?.[PROTOCOL_VERSION_META_KEY] !== undefined) {
                envelope = {
                    [PROTOCOL_VERSION_META_KEY]: meta[PROTOCOL_VERSION_META_KEY],
                    [CLIENT_INFO_META_KEY]: meta[CLIENT_INFO_META_KEY],
                    [CLIENT_CAPABILITIES_META_KEY]: meta[CLIENT_CAPABILITIES_META_KEY]
                };
            } else if (envelope !== undefined) {
                outbound = { ...message, params: { ...params, _meta: { ...envelope, ...meta } } };
            }
        }
        return origSend(outbound, opts);
    };
    return transport;
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
