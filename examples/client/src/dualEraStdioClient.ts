/**
 * Drives the dual-era stdio server example (`examples/server/src/dualEraStdio.ts`)
 * with both kinds of client over a real child-process pipe:
 *
 * 1. a plain 2025 client — the `initialize` handshake, served exactly as today;
 * 2. a 2026-capable client (`versionNegotiation: { mode: 'auto' }`) — the
 *    `server/discover` probe negotiates the 2026-07-28 revision on the pipe
 *    (no `initialize` is ever sent), and each modern request carries the
 *    per-request `_meta` envelope. (Attaching the envelope explicitly is a
 *    stop-gap: automatic per-request envelope emission is a client-side
 *    follow-up.)
 *
 * Build `examples/server` first; this client spawns the built server via stdio:
 *
 *     pnpm --filter @modelcontextprotocol/examples-server build
 *     tsx examples/client/src/dualEraStdioClient.ts
 */
import { Client, CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const SERVER = { command: 'node', args: ['../server/dist/dualEraStdio.js'] };

async function legacyLeg(): Promise<void> {
    console.log('--- leg 1: plain 2025 client (initialize handshake) ---');
    const client = new Client({ name: 'legacy-demo-client', version: '1.0.0' });
    await client.connect(new StdioClientTransport(SERVER));

    console.log('negotiated protocol version:', client.getNegotiatedProtocolVersion());
    const tools = await client.listTools();
    console.log(
        'tools:',
        tools.tools.map(tool => tool.name)
    );
    const result = await client.callTool({ name: 'greet', arguments: { name: '2025 client' } });
    console.log('greet result:', JSON.stringify(result.content));
    await client.close();
}

async function modernLeg(): Promise<void> {
    console.log('--- leg 2: 2026-capable client (server/discover negotiation) ---');
    const client = new Client({ name: 'modern-demo-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StdioClientTransport(SERVER));

    const negotiated = client.getNegotiatedProtocolVersion();
    console.log('negotiated protocol version:', negotiated);

    // The per-request envelope every 2026-era request carries on the wire.
    const envelope = {
        [PROTOCOL_VERSION_META_KEY]: negotiated,
        [CLIENT_INFO_META_KEY]: { name: 'modern-demo-client', version: '1.0.0' },
        [CLIENT_CAPABILITIES_META_KEY]: {}
    };

    const result = await client.request({
        method: 'tools/call',
        params: { name: 'greet', arguments: { name: '2026 client' }, _meta: envelope }
    });
    console.log('greet result:', JSON.stringify(result.content));
    await client.close();
}

await legacyLeg();
await modernLeg();
console.log('both legs served by the same dual-era stdio server.');
