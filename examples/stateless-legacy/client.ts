/**
 * Connects to the minimal `createMcpHandler` deployment as both a plain 2025
 * client (the `initialize` handshake, served stateless from the factory) and
 * a 2026-capable client (`versionNegotiation: { mode: 'auto' }`, served per
 * request). Asserts the same `greet` tool answers identically either way.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { check, runClient } from '../harness.js';

const argv = process.argv.slice(2);
const URL = argv[argv.indexOf('--http') + 1] ?? 'http://127.0.0.1:3000/';

runClient('stateless-legacy', async () => {
    for (const mode of [undefined, { mode: 'auto' as const }]) {
        const client = new Client({ name: 'stateless-legacy-client', version: '1.0.0' }, mode ? { versionNegotiation: mode } : {});
        await client.connect(new StreamableHTTPClientTransport(new globalThis.URL(URL)));
        const tools = await client.listTools();
        check.ok(tools.tools.some(t => t.name === 'greet'));
        const result = await client.callTool({ name: 'greet', arguments: { name: 'world' } });
        check.equal(result.content?.[0]?.type === 'text' ? result.content[0].text : '', 'Hello, world!');
        await client.close();
    }
});
