/**
 * Cloudflare Workers entry point for the "todos" reference server (the application itself
 * lives in todos.ts; the Node transport entry is ./server.ts). Serves the landing page at `/`
 * and MCP over Streamable HTTP at `/mcp`.
 *
 * Boards are per visitor: each visitor key maps to one Durable Object instance, which owns
 * that board's memory (hydrated from durable storage on wake, persisted on every change) and
 * one `ServerEventBus` — the single announce channel every serving mode shares. An alarm
 * wipes an idle board: this is a demo, boards are ephemeral by design.
 *
 * Two serving modes share each board:
 * - 2026-07-28 (and session-less legacy one-shots) ride `createMcpHandler`'s per-request
 *   model, exactly like the Node entry; the handler routes bus events onto its
 *   `subscriptions/listen` streams.
 * - 2025-era clients that POST `initialize` get a REAL session: a per-session
 *   `WebStandardStreamableHTTPServerTransport` connected to a server instance pinned to that
 *   session, so push-style server→client requests (elicitation/sampling — the interactive
 *   tools) work over HTTP. Each session subscribes its instance to the board's bus
 *   (`app.forwardServerEvent`), so `resources/subscribe` subscribers hear changes made on any
 *   connection; the subscription ends with the session. Session ids embed this object's own
 *   opaque id, and the worker routes session traffic by that prefix, so a session sticks to
 *   its board even when the client's egress IP rotates mid-session. Sessions are in-memory:
 *   if the object is evicted, the next request gets the spec's 404 and a conformant client
 *   re-initializes (the board itself is durable).
 */
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import {
    classifyInboundRequest,
    createMcpHandler,
    InMemoryServerEventBus,
    WebStandardStreamableHTTPServerTransport
} from '@modelcontextprotocol/server';

import indexHtml from './index.html';
import type { BoardSnapshot, TodosApp } from './todos';
import { createTodosApp } from './todos';

/** How long an untouched board survives before its alarm wipes it. */
const BOARD_TTL_MS = 2 * 60 * 60 * 1000;
/** Task-count cap per board unless the MAX_TASKS var overrides it. */
const DEFAULT_MAX_TASKS = 200;
/** Concurrent 2025-era sessions allowed per board. */
const MAX_SESSIONS = 8;
/** At the cap, sessions idle longer than this are evicted to make room. */
const SESSION_IDLE_MS = 30 * 60 * 1000;
/** Durable-storage keys: the board snapshot and the fallback requestState key. */
const BOARD_KEY = 'board:v2';
const CODEC_KEY_KEY = 'codecKey';

// Minimal structural types for the Workers runtime surface this file touches, so the example
// typechecks without adding @cloudflare/workers-types to the workspace. If this entry ever
// grows beyond them, switch to the real types package instead of extending these.
interface DurableObjectStub {
    fetch(request: Request): Promise<Response>;
}
interface DurableObjectId {
    toString(): string;
}
interface DurableObjectNamespace {
    idFromName(name: string): DurableObjectId;
    /** Throws on anything that is not an id minted by this namespace. */
    idFromString(id: string): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
}
interface DurableObjectStorage {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    getAlarm(): Promise<number | null>;
    setAlarm(scheduledTimeMs: number): Promise<void>;
}
interface DurableObjectState {
    id: DurableObjectId;
    storage: DurableObjectStorage;
    blockConcurrencyWhile(callback: () => Promise<void>): Promise<void>;
}

interface Env {
    BOARDS: DurableObjectNamespace;
    /**
     * HMAC key for the signed multi-round requestState (wrangler secret put REQUEST_STATE_SECRET).
     * Optional: without it each board mints its own key and persists it in durable storage, which
     * keeps multi-round flows verifiable across isolate recycling (rounds always route back to
     * the same board). A deployment-wide secret still wins when set.
     */
    REQUEST_STATE_SECRET?: string;
    /** Optional override for the per-board task cap (a number as a string; wrangler [vars]). */
    MAX_TASKS?: string;
}

/** A live 2025-era session: its transport, and when its client was last heard from. */
interface LegacySession {
    transport: WebStandardStreamableHTTPServerTransport;
    lastSeenMs: number;
}

/**
 * One visitor's board. The DO is the unit of coherence: its in-memory app instance serves
 * every request for this visitor, and the board's bus lives here too, so listen streams and
 * pinned sessions all hear this board's changes no matter which edge isolate a request hit.
 */
export class TodosBoard {
    private readonly state: DurableObjectState;
    private readonly sessions = new Map<string, LegacySession>();
    private readonly bus = new InMemoryServerEventBus();
    private app!: TodosApp;
    private handler!: McpHttpHandler;

    constructor(state: DurableObjectState, env: Env) {
        this.state = state;
        // Everything the first request needs — the codec key, the app, the hydrated board —
        // is set up before any event is delivered.
        void state.blockConcurrencyWhile(async () => {
            const requestStateKey = env.REQUEST_STATE_SECRET ?? (await this.loadOrCreateCodecKey());
            const parsedMaxTasks = Number(env.MAX_TASKS);
            const maxTasks = Number.isFinite(parsedMaxTasks) && parsedMaxTasks > 0 ? parsedMaxTasks : DEFAULT_MAX_TASKS;
            this.app = createTodosApp({ requestStateKey, maxTasks, bus: this.bus });
            this.handler = createMcpHandler(this.app.buildServer, { bus: this.bus });
            // The durable copy of the board follows the same announcements every client does.
            this.bus.subscribe(event => {
                if (event.kind === 'resource_updated') void this.persist();
            });
            const snapshot = await state.storage.get<BoardSnapshot>(BOARD_KEY);
            if (snapshot) this.app.restore(snapshot);
            // Every instantiated object carries a wipe alarm, so even a board that only ever
            // reads (or a session that never mutates) is cleaned up.
            if ((await state.storage.getAlarm()) === null) {
                await state.storage.setAlarm(Date.now() + BOARD_TTL_MS);
            }
        });
    }

    /**
     * Fallback requestState key, persisted next to the board: multi-round flows must survive
     * this object being evicted between rounds (a per-instance random key would reject its own
     * follow-up round with -32602 after any recycle).
     */
    private async loadOrCreateCodecKey(): Promise<Uint8Array> {
        const stored = await this.state.storage.get<Uint8Array>(CODEC_KEY_KEY);
        if (stored) return stored;
        const created = crypto.getRandomValues(new Uint8Array(32));
        await this.state.storage.put(CODEC_KEY_KEY, created);
        return created;
    }

    private async persist(): Promise<void> {
        await this.state.storage.put(BOARD_KEY, this.app.snapshot());
        // Sliding TTL: every change pushes the wipe out again.
        await this.state.storage.setAlarm(Date.now() + BOARD_TTL_MS);
    }

    /**
     * The TTL alarm: drop the stored board (the codec key stays — in-flight multi-round
     * requestState must not be invalidated by a wipe), reset the in-memory one in case we stay
     * resident, and end any sessions still pinned to this object.
     */
    async alarm(): Promise<void> {
        await this.state.storage.delete(BOARD_KEY);
        this.app.restore({ nextId: 1, tasks: [] });
        // Live clients hear the wipe like any other change.
        this.bus.publish({ kind: 'resources_list_changed' });
        this.bus.publish({ kind: 'resource_updated', uri: 'todos://board' });
        for (const session of this.sessions.values()) {
            await session.transport.close().catch(() => {});
        }
        // A resident object keeps its cleanup cycle: re-arm for the next window.
        await this.state.storage.setAlarm(Date.now() + BOARD_TTL_MS);
    }

    /**
     * A 2025-era `initialize` opens a session: its own transport (which mints the session id)
     * connected to a server instance pinned to this session, sharing this board. The SDK's
     * default-on legacy shim then serves the interactive tools as real push-style rounds over
     * the session's streams, and the bus subscription below delivers board changes made on any
     * other connection to this session's `resources/subscribe` subscribers.
     */
    private async createSession(request: Request): Promise<Response> {
        if (this.sessions.size >= MAX_SESSIONS) {
            // Make room by evicting idle sessions before refusing: an abandoned session
            // (client gone without DELETE) must not wedge the board at the cap forever.
            const cutoff = Date.now() - SESSION_IDLE_MS;
            for (const session of this.sessions.values()) {
                if (session.lastSeenMs < cutoff) await session.transport.close().catch(() => {});
            }
        }
        if (this.sessions.size >= MAX_SESSIONS) {
            return Response.json(
                {
                    jsonrpc: '2.0',
                    error: { code: -32_000, message: 'Too many concurrent sessions for this board — retry later.' },
                    id: null
                },
                { status: 429 }
            );
        }
        const prefix = this.state.id.toString();
        const server = this.app.buildServer({ era: 'legacy' });
        const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => `${prefix}.${crypto.randomUUID()}`,
            onsessioninitialized: sessionId => {
                this.sessions.set(sessionId, { transport, lastSeenMs: Date.now() });
            }
        });
        const unsubscribe = this.app.subscribeInstance(server);
        // Assigned BEFORE connect: the server chains a transport.onclose that is already set,
        // so both this teardown and the server's own run when the transport closes.
        transport.onclose = () => {
            unsubscribe();
            if (transport.sessionId !== undefined) this.sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
        const response = await transport.handleRequest(request);
        if (transport.sessionId === undefined) {
            // The transport refused the handshake (schema-invalid initialize, bad Accept, …):
            // no session was minted, so nothing else will ever run the teardown. Close now —
            // otherwise the bus subscription pins this server as a zombie for the DO's life.
            await transport.close().catch(() => {});
        }
        return response;
    }

    async fetch(request: Request): Promise<Response> {
        // Session traffic goes to that session's own transport.
        const sessionId = request.headers.get('mcp-session-id');
        if (sessionId !== null) {
            const session = this.sessions.get(sessionId);
            if (!session) {
                // Evicted or expired: the spec's 404 tells the client to re-initialize.
                return Response.json({ jsonrpc: '2.0', error: { code: -32_001, message: 'Session not found' }, id: null }, { status: 404 });
            }
            session.lastSeenMs = Date.now();
            return session.transport.handleRequest(request);
        }

        // A session-less legacy `initialize` opens a session; every other request rides the
        // per-request handler unchanged. The routing decision comes from the entry's own
        // exported classifier — `reason: 'initialize'` names exactly the legacy handshake,
        // and never disagrees with createMcpHandler on the edge cells (an `initialize`
        // carrying a modern envelope claim or a modern MCP-Protocol-Version header belongs
        // to the modern path). Other legacy cells stay on the stateless handler by design.
        if (request.method === 'POST') {
            const body: unknown = await request
                .clone()
                .json()
                .catch(() => {});
            const outcome = classifyInboundRequest({
                httpMethod: request.method,
                protocolVersionHeader: request.headers.get('mcp-protocol-version') ?? undefined,
                mcpMethodHeader: request.headers.get('mcp-method') ?? undefined,
                mcpNameHeader: request.headers.get('mcp-name') ?? undefined,
                body
            });
            if (outcome.kind === 'legacy' && outcome.reason === 'initialize') {
                return this.createSession(request);
            }
            return this.handler.fetch(request, body === undefined ? undefined : { parsedBody: body });
        }
        return this.handler.fetch(request);
    }
}

// The endpoint is public and credential-free, so a wide-open CORS posture is deliberate:
// browser-based MCP clients (inspectors, playgrounds) can connect straight from the page.
// Headers go on EVERY response (including errors and the 404) — a browser client can only
// read a diagnostic that carries them.
function corsHeaders(request: Request): Record<string, string> {
    return {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        // Reflect the requested headers: the '*' wildcard never covers Authorization.
        'access-control-allow-headers': request.headers.get('access-control-request-headers') ?? '*',
        'access-control-expose-headers': '*',
        'access-control-max-age': '86400'
    };
}

function withCors(request: Request, response: Response): Response {
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(corsHeaders(request))) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// The landing page is constant per deployment origin — substitute once per isolate.
let landingPage: { origin: string; html: string } | undefined;
function renderLandingPage(origin: string): string {
    if (landingPage?.origin !== origin) landingPage = { origin, html: indexHtml.replaceAll('__HOST__', origin) };
    return landingPage.html;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        const response = await (async (): Promise<Response> => {
            if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

            if (url.pathname === '/mcp') {
                // Board routing. A session id starts with the id of the object that minted it
                // (opaque, unguessable, validated by idFromString), so a session survives the
                // client's egress IP rotating. Everything else routes by the connecting
                // address, or by the X-Todos-Board header for a board of the client's own
                // naming — the two namespaced so a header value can never collide with (and
                // read) somebody's address-keyed board.
                const sessionId = request.headers.get('mcp-session-id');
                let id: DurableObjectId | undefined;
                if (sessionId === null) {
                    const named = request.headers.get('x-todos-board');
                    const visitor = named ? `named:${named.slice(0, 128)}` : `ip:${request.headers.get('cf-connecting-ip') ?? 'anonymous'}`;
                    id = env.BOARDS.idFromName(visitor);
                } else {
                    try {
                        id = env.BOARDS.idFromString(sessionId.split('.')[0] ?? '');
                    } catch {
                        return Response.json(
                            { jsonrpc: '2.0', error: { code: -32_001, message: 'Session not found' }, id: null },
                            { status: 404 }
                        );
                    }
                }
                try {
                    return await env.BOARDS.get(id).fetch(request);
                } catch (error) {
                    // Details stay server-side; clients get a stable, generic shape.
                    console.error('board fetch failed:', error);
                    return Response.json({ error: 'board unavailable' }, { status: 500 });
                }
            }

            if (url.pathname === '/') {
                return new Response(renderLandingPage(url.origin), {
                    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' }
                });
            }

            return new Response('Not found. The MCP endpoint is /mcp; see / for how to connect.\n', {
                status: 404,
                headers: { 'content-type': 'text/plain; charset=utf-8' }
            });
        })();
        return withCors(request, response);
    }
};
