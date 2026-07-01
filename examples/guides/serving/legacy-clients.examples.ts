/**
 * Companion example for `docs/serving/legacy-clients.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness below the
 * regions drives `handler.fetch` in process — no port, no socket — and
 * produces the output the page quotes verbatim.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/serving/legacy-clients.examples.ts        # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
import { serveStdio } from '@modelcontextprotocol/server/stdio';

// ---------------------------------------------------------------------------
// "Choose a legacy posture"
// ---------------------------------------------------------------------------

//#region createMcpHandler_legacyReject
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

const buildServer = () => new McpServer({ name: 'notes', version: '1.0.0' });

const strict = createMcpHandler(buildServer, { legacy: 'reject' });
//#endregion createMcpHandler_legacyReject

// ---------------------------------------------------------------------------
// "Choose the same posture on stdio" — never invoked: `serveStdio` over real
// stdio would hold this program open on stdin. The posture is the point.
// ---------------------------------------------------------------------------

/** Example: the same posture on the stdio entry. */
function rejectOnStdio(): void {
    //#region serveStdio_legacyReject
    serveStdio(buildServer, { legacy: 'reject' });
    //#endregion serveStdio_legacyReject
}
void rejectOnStdio;

// ---------------------------------------------------------------------------
// "Keep a sessionful 2025 deployment running"
// ---------------------------------------------------------------------------

//#region isLegacyRequest_route
import { isLegacyRequest, legacyStatelessFallback } from '@modelcontextprotocol/server';

const legacy = legacyStatelessFallback(buildServer);

async function serve(request: Request): Promise<Response> {
    if (await isLegacyRequest(request)) {
        return legacy(request);
    }
    return strict.fetch(request);
}
//#endregion isLegacyRequest_route

// ---------------------------------------------------------------------------
// "Serve elicitation to 2025-era HTTP clients"
// ---------------------------------------------------------------------------

//#region isLegacyRequest_sessions
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

const handler = createMcpHandler(buildServer);
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

async function serveWithSessions(request: Request): Promise<Response> {
    // Session traffic goes to the transport that owns the session.
    const sessionId = request.headers.get('mcp-session-id');
    if (sessionId !== null) {
        const transport = sessions.get(sessionId);
        if (!transport) return new Response('Unknown or expired session', { status: 404 });
        return transport.handleRequest(request);
    }

    // A legacy `initialize` opens a session: its own transport, its own instance.
    const body: unknown =
        request.method === 'POST'
            ? await request
                  .clone()
                  .json()
                  .catch(() => {})
            : undefined;
    const looksLikeInitialize = typeof body === 'object' && body !== null && 'method' in body && body.method === 'initialize';
    if (looksLikeInitialize && (await isLegacyRequest(request, body))) {
        const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: id => {
                sessions.set(id, transport);
            }
        });
        // Set before connect: the server chains an onclose that is already on the transport.
        transport.onclose = () => {
            if (transport.sessionId !== undefined) sessions.delete(transport.sessionId);
        };
        await buildServer().connect(transport);
        const response = await transport.handleRequest(request);
        // A refused handshake mints no session: close, or the pair leaks until process exit.
        if (transport.sessionId === undefined) await transport.close();
        return response;
    }

    // Everything else — modern traffic and legacy one-shots — rides the entry.
    return handler.fetch(request, body === undefined ? undefined : { parsedBody: body });
}
//#endregion isLegacyRequest_sessions

// ---------------------------------------------------------------------------
// Harness (not shown on the page). A 2025-era client opens with a claim-less
// `initialize` POST; build that request twice and send it to the strict
// handler, then through the `isLegacyRequest` branch. The page quotes both
// outputs verbatim; the self-checks at the bottom exit non-zero if either
// claim stops being observable.
// ---------------------------------------------------------------------------

const legacyInitialize = () =>
    new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy-host', version: '1.0.0' } }
        })
    });

// "Choose a legacy posture" — the strict rejection the page quotes.
const rejected = await strict.fetch(legacyInitialize());
const rejection = (await rejected.json()) as { error: { code: number; data: { supported: string[]; requested: string } } };
console.log(rejected.status);
console.log(JSON.stringify(rejection, null, 2));

// "Keep a sessionful 2025 deployment running" — the same request through the
// branch reaches the legacy leg and completes the 2025 handshake over SSE.
const served = await serve(legacyInitialize());
const sse = await served.text();
const dataLine = sse.split('\n').find(line => line.startsWith('data: '));
const initialized = JSON.parse(dataLine?.slice('data: '.length) ?? '{}') as {
    result: { protocolVersion: string; serverInfo: { name: string; version: string } };
};
console.log(served.status);
console.log(initialized.result);

// Self-verification — the page's claims must stay observable.
if (rejected.status !== 400 || rejection.error.code !== -32_022) {
    throw new Error(`expected the 400 / -32022 strict rejection, got ${rejected.status} ${JSON.stringify(rejection)}`);
}
if (rejection.error.data.supported[0] !== '2026-07-28' || rejection.error.data.requested !== '2025-06-18') {
    throw new Error(`expected the supported/requested revisions in the error data, got ${JSON.stringify(rejection.error.data)}`);
}
if (served.status !== 200 || initialized.result.protocolVersion !== '2025-06-18') {
    throw new Error(`expected the legacy leg to complete the 2025 handshake, got ${served.status} ${JSON.stringify(initialized)}`);
}

// "Serve elicitation to 2025-era HTTP clients" — the hybrid mints a session for
// the legacy handshake, routes session traffic to the pinned instance, leaves
// everything else (including a modern-envelope `initialize`) to the entry, and
// tears the session down on DELETE.
const opened = await serveWithSessions(legacyInitialize());
await opened.text();
const sessionId = opened.headers.get('mcp-session-id');
console.log(opened.status, sessionId === null ? 'no session' : 'Mcp-Session-Id minted');

const overSession = (init: RequestInit): Request =>
    new Request('http://localhost/mcp', {
        ...init,
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-session-id': sessionId ?? ''
        }
    });
const acked = await serveWithSessions(
    overSession({ method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
);
await acked.text();
const pinged = await serveWithSessions(overSession({ method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) }));
const pingedBody = await pinged.text();
console.log(pinged.status);

const modernInitialize = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28' },
    body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'initialize',
        params: {
            _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': { name: 'modern-host', version: '1.0.0' },
                'io.modelcontextprotocol/clientCapabilities': {}
            }
        }
    })
});
const answeredByEntry = await serveWithSessions(modernInitialize);
await answeredByEntry.text();
const closed = await serveWithSessions(overSession({ method: 'DELETE' }));
await closed.text();

// Self-verification for the sessions section.
if (opened.status !== 200 || sessionId === null) {
    throw new Error(`expected the legacy initialize to mint a session, got ${opened.status} ${String(sessionId)}`);
}
if (acked.status !== 202 || pinged.status !== 200 || !pingedBody.includes('"result"')) {
    throw new Error(`expected the session to serve the follow-up, got ${acked.status} then ${pinged.status} ${pingedBody.slice(0, 200)}`);
}
if (answeredByEntry.headers.get('mcp-session-id') !== null) {
    throw new Error('expected a modern-envelope initialize to be answered by the entry, not given a 2025 session');
}
if (sessions.size !== 0) {
    throw new Error(`expected DELETE to tear the session down, ${sessions.size} left (DELETE answered ${closed.status})`);
}

await strict.close();
await handler.close();
