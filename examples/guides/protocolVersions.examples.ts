/**
 * Companion example for `docs/protocol-versions.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness routes
 * `globalThis.fetch` for the page's two URLs in-process — `localhost:3000` is
 * the `createMcpHandler` entry built below (serves both eras) and
 * `localhost:4000` is a 2025-only server — so the probe, the fallback, and the
 * pin rejection the page quotes all execute for real without binding a port.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/protocolVersions.examples.ts        # from examples/
 *
 * @module
 */
/* eslint-disable no-console */

// ## Serve both eras from one entry point
// (Defined first so the harness can route to it; the page introduces it last.)

//#region createMcpHandler_bothEras
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const handler = createMcpHandler(({ era }) => {
    const server = new McpServer({ name: 'forecast', version: '1.0.0' });
    server.registerTool(
        'forecast',
        {
            description: 'Forecast for a city',
            inputSchema: z.object({ city: z.string() })
        },
        async ({ city }) => ({ content: [{ type: 'text', text: `${city}: sunny (${era} era)` }] })
    );
    return server;
});
//#endregion createMcpHandler_bothEras

// ---------------------------------------------------------------------------
// Harness (not shown on the page). `localhost:4000` is a 2025-only server:
// `legacyStatelessFallback` is the same stateless 2025 serving that
// `createMcpHandler` uses for its own legacy traffic, exposed standalone. It
// never recognizes `server/discover`, so an `'auto'` probe against it falls
// back and a pin against it rejects.
// ---------------------------------------------------------------------------

const { legacyStatelessFallback } = await import('@modelcontextprotocol/server');
const legacyOnly = legacyStatelessFallback(() => new McpServer({ name: 'forecast-2025', version: '1.0.0' }));

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const { host } = new URL(request.url);
    if (host === 'localhost:3000') return handler.fetch(request);
    if (host === 'localhost:4000') return legacyOnly(request);
    return realFetch(input, init);
}) as typeof fetch;

// ## Negotiate the era from the client — `'auto'` against the both-era endpoint.

//#region versionNegotiation_auto
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'my-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });

await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp')));

console.log(client.getProtocolEra());
//#endregion versionNegotiation_auto

// The same options against the 2025-only endpoint: the probe finds nothing
// modern and `connect()` falls back to `initialize` on the same connection.

//#region versionNegotiation_fallback
const fallback = new Client({ name: 'my-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });

await fallback.connect(new StreamableHTTPClientTransport(new URL('http://localhost:4000/mcp')));

console.log(fallback.getProtocolEra());
//#endregion versionNegotiation_fallback

// ## The constants are era-scoped — names carry the initialize/discover split.

//#region isModernProtocolVersion_classify
import { isModernProtocolVersion, LATEST_LEGACY_PROTOCOL_VERSION } from '@modelcontextprotocol/client';

console.log(`initialize offers: ${LATEST_LEGACY_PROTOCOL_VERSION}`);

for (const connection of [fallback, client]) {
    const version = connection.getNegotiatedProtocolVersion();
    if (version) console.log(`${version} → ${isModernProtocolVersion(version) ? 'modern' : 'legacy'}`);
}
//#endregion isModernProtocolVersion_classify

// ## Pin an era — a pin never falls back; against a 2025-only server it rejects.

//#region versionNegotiation_pin
import { SdkError } from '@modelcontextprotocol/client';

const pinned = new Client({ name: 'my-client', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });

try {
    await pinned.connect(new StreamableHTTPClientTransport(new URL('http://localhost:4000/mcp')));
} catch (error) {
    if (error instanceof SdkError) console.log(`${error.code}: ${error.message}`);
}
//#endregion versionNegotiation_pin

// ## Serve both eras from one entry point — the era reaches the factory.

//#region createMcpHandler_callBothEras
const defaultClient = new Client({ name: 'my-client', version: '1.0.0' });

await defaultClient.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp')));

for (const caller of [client, defaultClient]) {
    const result = await caller.callTool({ name: 'forecast', arguments: { city: 'Berlin' } });
    console.log(caller.getProtocolEra(), JSON.stringify(result.content));
}
//#endregion createMcpHandler_callBothEras

await client.close();
await fallback.close();
await defaultClient.close();
await handler.close();
globalThis.fetch = realFetch;

// ---------------------------------------------------------------------------
// ## Understand the probe — the options block is never connected; it exists to
// typecheck the `probe` shape the page shows.
// ---------------------------------------------------------------------------

function versionNegotiation_probe(): Client {
    //#region versionNegotiation_probe
    const cli = new Client(
        { name: 'my-client', version: '1.0.0' },
        {
            versionNegotiation: {
                mode: 'auto',
                probe: {
                    timeoutMs: 10_000, // default: the connection's request timeout
                    maxRetries: 0 // default: no probe re-sends after a timeout
                }
            }
        }
    );
    //#endregion versionNegotiation_probe
    return cli;
}

void versionNegotiation_probe;
