/**
 * Cloudflare Workers entry point for the "todos" reference server (the application itself
 * lives in todos.ts; the Node transport entry is ./server.ts; the OAuth glue in ./oauth.ts).
 * `@cloudflare/workers-oauth-provider` wraps the worker as the Authorization Server: the
 * landing page and anonymous `/mcp` ride its defaultHandler unchanged, while `/oauth/mcp`
 * serves token-authorized boards — the provider verifies, `propsToAuthInfo` maps the grant
 * into the SDK's `AuthInfo`, and the board IS the grant (no user accounts).
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
 *   (`app.subscribeInstance`), so `resources/subscribe` subscribers hear changes made on any
 *   connection; the subscription ends with the session. Session ids embed this object's own
 *   opaque id, and the worker routes session traffic by that prefix, so a session sticks to
 *   its board even when the client's egress IP rotates mid-session. Sessions are in-memory:
 *   if the object is evicted, the next request gets the spec's 404 and a conformant client
 *   re-initializes (the board itself is durable).
 */
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import type { AuthInfo, McpHttpHandler } from '@modelcontextprotocol/server';
import {
    classifyInboundRequest,
    createMcpHandler,
    InMemoryServerEventBus,
    WebStandardStreamableHTTPServerTransport
} from '@modelcontextprotocol/server';
import { WorkerEntrypoint } from 'cloudflare:workers';

import boardScript from './board.client.js';
import boardHtml from './board.html';
import indexHtml from './index.html';
import type { OAuthHelpers, TodosGrantProps, ViewerSessionStore } from './oauth';
import { handleAuthorize, propsToAuthInfo, resolveViewerBoard } from './oauth';
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
    /** Grant/token storage for the OAuth provider; also holds live-view viewer sessions. */
    OAUTH_KV: ViewerSessionStore;
    /** Injected by the provider: parseAuthRequest/lookupClient/completeAuthorization. */
    OAUTH_PROVIDER: OAuthHelpers;
    /** Set to '1' to auto-approve consent — used by the scripted end-to-end dance. */
    TODOS_AUTO_CONSENT?: string;
}

/** Internal relay: the API handler forwards verified auth into the board object. */
const AUTH_RELAY_HEADER = 'x-todos-authinfo';
/** Internal relay: how the live view resolved this board, echoed as the stream's first frame. */
const VIEW_INFO_HEADER = 'x-todos-view-info';

/** The live view's identity frame (the SSE stream's first event; board.client.js renders it). */
interface ViewInfo {
    mode: 'named' | 'oauth' | 'address';
    label: string;
}

// Board names are namespaced so one keying scheme can never collide with (and read)
// another's boards: a client-chosen header value, a network address, and a grant id
// live in disjoint prefixes.
const boardName = {
    auth: (boardId: string): string => `auth:${boardId}`,
    named: (raw: string): string => `named:${raw.slice(0, 128)}`,
    ip: (request: Request): string => `ip:${request.headers.get('cf-connecting-ip') ?? 'anonymous'}`
};

// A session id is `<minting object's own id>.<uuid>`: opaque, unguessable, and
// self-routing (the prefix names the board object that owns the session).
function mintSessionId(doId: DurableObjectId): string {
    return `${doId.toString()}.${crypto.randomUUID()}`;
}
function boardOfSession(sessionId: string): string {
    return sessionId.split('.')[0] ?? '';
}

/** A live 2025-era session: its transport, tier, and when its client was last heard from. */
interface LegacySession {
    transport: WebStandardStreamableHTTPServerTransport;
    /** Minted through the provider-verified route: every request must arrive the same way. */
    authed: boolean;
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
            // The public origin is learned from the first request (fetch stores it),
            // so links in instructions/whoami are absolute without any configuration.
            this.app = createTodosApp({
                requestStateKey,
                maxTasks,
                bus: this.bus,
                boardViewPath: () => `${this.origin ?? ''}/board`
            });
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
    private async createSession(request: Request, authInfo?: AuthInfo): Promise<Response> {
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
        const server = this.app.buildServer({ era: 'legacy', ...(authInfo === undefined ? {} : { authInfo }) });
        const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => mintSessionId(this.state.id),
            onsessioninitialized: sessionId => {
                this.sessions.set(sessionId, { transport, authed: authInfo !== undefined, lastSeenMs: Date.now() });
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

    /**
     * A live read-only view of this board: the current snapshot immediately, then a fresh
     * snapshot on every change, as server-sent events. Just another bus subscriber — the
     * same seam the durable copy and the pinned sessions use.
     */
    private boardEventStream(viewInfo: string): Response {
        const encoder = new TextEncoder();
        let unsubscribe: (() => void) | undefined;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const stream = new ReadableStream<Uint8Array>({
            start: controller => {
                controller.enqueue(encoder.encode(`event: info\ndata: ${viewInfo}\n\n`));
                const send = (): void => {
                    try {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(this.app.snapshot())}\n\n`));
                    } catch {
                        // Stream already closed; the cancel() teardown handles the rest.
                    }
                };
                send();
                unsubscribe = this.bus.subscribe(event => {
                    if (event.kind === 'resource_updated') send();
                });
                heartbeat = setInterval(() => {
                    try {
                        controller.enqueue(encoder.encode(': keepalive\n\n'));
                    } catch {
                        /* closed */
                    }
                }, 25_000);
            },
            cancel: () => {
                unsubscribe?.();
                if (heartbeat !== undefined) clearInterval(heartbeat);
            }
        });
        return new Response(stream, {
            headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }
        });
    }

    private origin?: string;

    async fetch(request: Request): Promise<Response> {
        this.origin ??= new URL(request.url).origin;
        if (new URL(request.url).pathname === '/board/events') {
            // serveBoard's view route always sets the header; the fallback only guards a
            // direct DO hit that production routing cannot produce.
            return this.boardEventStream(request.headers.get(VIEW_INFO_HEADER) ?? '{"mode":"address","label":"your network address"}');
        }
        // Verified auth relayed by the API handler (never trusted from clients: the
        // anonymous route strips this header before the request reaches any board).
        const relayed = request.headers.get(AUTH_RELAY_HEADER);
        const authInfo = relayed === null ? undefined : (JSON.parse(relayed) as AuthInfo);
        // Session traffic goes to that session's own transport — but never across tiers.
        // An OAuth-minted session must arrive through the provider-verified route on every
        // request (so token expiry and revocation cut it off), and an anonymous session id
        // is worthless on the authed route: a session id alone is never a credential.
        const sessionId = request.headers.get('mcp-session-id');
        if (sessionId !== null) {
            const session = this.sessions.get(sessionId);
            if (!session) {
                // Evicted or expired: the spec's 404 tells the client to re-initialize.
                return Response.json({ jsonrpc: '2.0', error: { code: -32_001, message: 'Session not found' }, id: null }, { status: 404 });
            }
            if (session.authed !== (authInfo !== undefined)) {
                return Response.json(
                    { jsonrpc: '2.0', error: { code: -32_001, message: 'Session not found on this endpoint' }, id: null },
                    { status: session.authed ? 401 : 404 }
                );
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
                return this.createSession(request, authInfo);
            }
            return this.handler.fetch(request, { ...(body === undefined ? {} : { parsedBody: body }), authInfo });
        }
        return this.handler.fetch(request, { authInfo });
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

// Applied once, at the outermost wrapper: fills in whatever CORS headers a response
// does not already carry (the provider sets its own on some routes).
function withCors(request: Request, response: Response): Response {
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(corsHeaders(request))) {
        if (!headers.has(name)) headers.set(name, value);
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Pages are constant per deployment origin — substitute once per isolate.
function pageRenderer(html: string): (origin: string) => string {
    let cached: { origin: string; rendered: string } | undefined;
    return origin => {
        if (cached?.origin !== origin) cached = { origin, rendered: html.replaceAll('__HOST__', origin) };
        return cached.rendered;
    };
}
const renderLandingPage = pageRenderer(indexHtml);
const renderBoardPage = pageRenderer(boardHtml.replace('__BOARD_SCRIPT__', () => boardScript));

/** How a request is allowed to reach a board — the whole tier model in one type. */
type BoardRoute =
    // MCP traffic. Sessions may re-route to the object that minted them (that is how a
    // session survives egress-IP rotation) — but on the token-verified route a session
    // must belong to the token's own board, and the verified identity rides along.
    | { kind: 'mcp'; board: string; authInfo?: AuthInfo }
    // The read-only live view. Never routes by session id, never carries identity.
    | { kind: 'view'; board: string; viewInfo: ViewInfo };

function sessionNotFound(): Response {
    return Response.json({ jsonrpc: '2.0', error: { code: -32_001, message: 'Session not found' }, id: null }, { status: 404 });
}

/**
 * The single door to a board object. Owns every internal-header and session-routing
 * rule: inbound copies of the internal headers are always dropped (clients cannot
 * assert an identity or a view), and only this function decides which object serves
 * the request. Callers describe intent with a BoardRoute and never touch headers.
 */
async function serveBoard(request: Request, env: Env, route: BoardRoute): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.delete(AUTH_RELAY_HEADER);
    headers.delete(VIEW_INFO_HEADER);

    let id: DurableObjectId;
    const sessionId = route.kind === 'mcp' ? request.headers.get('mcp-session-id') : null;
    if (route.kind === 'view') headers.delete('mcp-session-id');
    if (sessionId === null) {
        id = env.BOARDS.idFromName(route.board);
    } else {
        if (route.kind === 'mcp' && route.authInfo && boardOfSession(sessionId) !== env.BOARDS.idFromName(route.board).toString()) {
            return sessionNotFound();
        }
        try {
            id = env.BOARDS.idFromString(boardOfSession(sessionId));
        } catch {
            return sessionNotFound();
        }
    }
    if (route.kind === 'mcp' && route.authInfo) headers.set(AUTH_RELAY_HEADER, JSON.stringify(route.authInfo));
    if (route.kind === 'view') headers.set(VIEW_INFO_HEADER, JSON.stringify(route.viewInfo));
    try {
        return await env.BOARDS.get(id).fetch(new Request(request, { headers }));
    } catch (error) {
        // Details stay server-side; clients get a stable, generic shape.
        console.error('board fetch failed:', error);
        return Response.json({ error: 'board unavailable' }, { status: 500 });
    }
}

/**
 * Token-authorized MCP: the provider has already verified the access token and
 * decrypted the grant's props. The board IS the grant (`auth:<boardId>`), and the
 * verified identity rides an internal header into the board object, where it
 * surfaces to tool handlers as `ctx.authInfo`.
 */
export class TodosApi extends WorkerEntrypoint<Env> {
    override async fetch(request: Request): Promise<Response> {
        const props = (this.ctx as { props?: TodosGrantProps }).props;
        if (!props?.boardId) {
            return Response.json({ error: 'invalid grant' }, { status: 403 });
        }
        return serveBoard(request, this.env, {
            kind: 'mcp',
            board: boardName.auth(props.boardId),
            authInfo: propsToAuthInfo(props, request)
        });
    }
}

const defaultHandler = {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

        if (url.pathname === '/mcp') {
            // Anonymous tier: boards keyed by the X-Todos-Board header (a board of the
            // client's own naming) or the connecting address.
            const named = request.headers.get('x-todos-board');
            return serveBoard(request, env, {
                kind: 'mcp',
                board: named ? boardName.named(named) : boardName.ip(request)
            });
        }

        if (url.pathname === '/authorize' || url.pathname === '/authorize/approve') {
            return handleAuthorize(request, env.OAUTH_PROVIDER, env.TODOS_AUTO_CONSENT === '1', env.OAUTH_KV);
        }

        if (url.pathname === '/board') {
            return new Response(renderBoardPage(url.origin), {
                headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' }
            });
        }

        if (url.pathname === '/board/events') {
            // Read-only live view. ?b=<name> names an anonymous board; without it, a
            // viewer cookie claimed at OAuth consent resolves to that grant's own
            // board, falling back to the viewer's address-keyed board. Board ids and
            // tokens never appear in URLs.
            if (request.method !== 'GET') return new Response(null, { status: 405 });
            const named = url.searchParams.get('b');
            let route: BoardRoute | undefined;
            if (named) {
                route = { kind: 'view', board: boardName.named(named), viewInfo: { mode: 'named', label: named.slice(0, 128) } };
            } else {
                const viewer = await resolveViewerBoard(request.headers.get('cookie'), env.OAUTH_KV);
                if (viewer) {
                    route = {
                        kind: 'view',
                        board: boardName.auth(viewer.boardId),
                        viewInfo: { mode: 'oauth', label: `${viewer.clientName ?? 'your client'} · ${viewer.boardId.slice(0, 8)}` }
                    };
                }
            }
            route ??= { kind: 'view', board: boardName.ip(request), viewInfo: { mode: 'address', label: 'your network address' } };
            return serveBoard(request, env, route);
        }

        if (url.pathname === '/') {
            return new Response(renderLandingPage(url.origin), {
                headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' }
            });
        }

        return new Response('Not found. The MCP endpoint is /mcp (anonymous) or /oauth/mcp (OAuth); see / for how to connect.\n', {
            status: 404,
            headers: { 'content-type': 'text/plain; charset=utf-8' }
        });
    }
};

// The provider owns the OAuth endpoints (authorize/token/register + both discovery
// documents), verifies tokens on the API route, and passes everything else through
// to the default handler. CIMD needs the global_fetch_strictly_public compatibility
// flag (wrangler.toml): the platform itself guarantees metadata fetches only reach
// public addresses.
const provider = new OAuthProvider({
    apiRoute: '/oauth/mcp',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apiHandler: TodosApi as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    defaultHandler: defaultHandler as any,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: ['todos'],
    clientIdMetadataDocumentEnabled: true
});

export default {
    // Browser-based MCP clients must be able to READ the provider's 401 challenge
    // (WWW-Authenticate) and discovery documents cross-origin. The provider sets its
    // own CORS on some routes; ours fills in only what is missing.
    async fetch(request: Request, env: Env, ctx: unknown): Promise<Response> {
        const response = await (provider as unknown as { fetch(request: Request, env: Env, ctx: unknown): Promise<Response> }).fetch(
            request,
            env,
            ctx
        );
        return withCors(request, response);
    }
};
