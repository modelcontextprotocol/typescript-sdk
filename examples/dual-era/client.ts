/**
 * Drives the dual-era server (`./server.ts`) over the selected transport with
 * BOTH kinds of client:
 *
 * 1. a plain 2025 client (`versionNegotiation: { mode: 'legacy' }`) — the
 *    `initialize` handshake, served exactly as today (the server reports
 *    `era === 'legacy'`);
 * 2. a 2026-capable client (`versionNegotiation: { mode: 'auto' }`) — the
 *    `server/discover` probe negotiates the 2026-07-28 revision (no
 *    `initialize` is ever sent) and the SDK attaches the per-request `_meta`
 *    envelope itself (the server reports `era === 'modern'`).
 *
 * Asserts both legs and exits 0 — used as a self-verifying e2e by
 * `scripts/examples/run-examples.ts` over stdio AND http.
 */
import { check, parseExampleArgs, siblingPath } from '@mcp-examples/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// The story body drives BOTH eras itself, so the argv `era` flag is unused;
// only the transport leg is read from argv.
const { transport, url } = parseExampleArgs();

const connect = async (mode: 'legacy' | 'auto'): Promise<Client> => {
    const client = new Client({ name: 'dual-era-example-client', version: '1.0.0' }, { versionNegotiation: { mode } });
    await (transport === 'stdio'
        ? client.connect(new StdioClientTransport({ command: 'npx', args: ['-y', 'tsx', siblingPath(import.meta.url, 'server.ts')] }))
        : client.connect(new StreamableHTTPClientTransport(new URL(url))));
    return client;
};

// --- leg 1: plain 2025 client (initialize handshake) ---
const legacy = await connect('legacy');
const legacyTools = await legacy.listTools();
check.ok(legacyTools.tools.some(t => t.name === 'greet'));
const legacyGreet = await legacy.callTool({ name: 'greet', arguments: { name: '2025 client' } });
const legacyText = legacyGreet.content?.[0]?.type === 'text' ? legacyGreet.content[0].text : '';
check.match(legacyText, /Hello, 2025 client! \(served on the legacy protocol era\)/);
await legacy.close();

// --- leg 2: 2026-capable client (server/discover negotiation) ---
const modern = await connect('auto');
check.equal(modern.getNegotiatedProtocolVersion(), '2026-07-28');
const modernGreet = await modern.callTool({ name: 'greet', arguments: { name: '2026 client' } });
const modernText = modernGreet.content?.[0]?.type === 'text' ? modernGreet.content[0].text : '';
check.match(modernText, /Hello, 2026 client! \(served on the modern protocol era\)/);
await modern.close();

console.log('both eras served by the same factory over the same transport.');
