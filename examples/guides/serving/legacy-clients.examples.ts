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

await strict.close();
