/**
 * Companion example for `docs/troubleshooting.md`.
 *
 * Every `ts` fence on that page except the stdio one is synced from a
 * `//#region` in this file (`pnpm sync:snippets --check`); the stdio fence
 * lives in `troubleshooting.stdio.examples.ts` because `serveStdio` binds
 * stdin and would keep this program from terminating. The file also runs: the
 * harness below connects in-memory clients to a 2025-only server and produces
 * the error messages the page quotes verbatim.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/troubleshooting.examples.ts        # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
/* eslint-disable unicorn/no-typeof-undefined -- the typeof form also covers runtimes where the global is not declared at all */
//#region webcrypto_polyfill
import { webcrypto } from 'node:crypto';

if (typeof globalThis.crypto === 'undefined') {
    globalThis.crypto = webcrypto;
}
//#endregion webcrypto_polyfill

import { Client, InMemoryTransport, SdkError } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';

// ---------------------------------------------------------------------------
// Harness (not shown on the page). A bare `McpServer` connected over an
// in-memory pair never serves `server/discover`, so it stands in for any
// server that has not adopted the 2026-07-28 revision. Each scenario gets a
// fresh server + linked transport pair.
// ---------------------------------------------------------------------------

const servers: McpServer[] = [];
async function legacyServerTransport(): Promise<InMemoryTransport> {
    const server = new McpServer({ name: 'app', version: '1.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    servers.push(server);
    return clientSide;
}

// "SdkError: ERA_NEGOTIATION_FAILED" — the rejection the page quotes.
let transport = await legacyServerTransport();
//#region connect_pinRejected
const pinned = new Client({ name: 'app', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });

try {
    await pinned.connect(transport);
} catch (error) {
    if (!(error instanceof SdkError)) throw error;
    console.log(`${error.code}: ${error.message}`);
}
//#endregion connect_pinRejected

// "SdkError: ERA_NEGOTIATION_FAILED" — the `mode: 'auto'` fix the page quotes.
transport = await legacyServerTransport();
//#region connect_autoFallback
const negotiated = new Client({ name: 'app', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });

await negotiated.connect(transport);
console.log(negotiated.getProtocolEra());
//#endregion connect_autoFallback

// "SdkError: METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION" — the rejection the page quotes.
transport = await legacyServerTransport();
//#region listen_legacyConnection
const client = new Client({ name: 'app', version: '1.0.0' });
await client.connect(transport);

try {
    await client.listen({ resourceSubscriptions: ['file:///logs/app.log'] });
} catch (error) {
    if (!(error instanceof SdkError)) throw error;
    console.log(`${error.code}: ${error.message}`);
}
//#endregion listen_legacyConnection

await negotiated.close();
await client.close();
for (const server of servers) {
    await server.close();
}
