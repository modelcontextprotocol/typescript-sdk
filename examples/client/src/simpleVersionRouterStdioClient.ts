/**
 * Demonstrates: Client + StdioClientVersionRouter
 *
 * Automatically detects whether the server supports modern (2026-06)
 * or legacy (2025-11) protocol. If the server responds to
 * server/discover, the connection is modern; otherwise it falls back
 * to the initialize handshake.
 */

import { Client, StdioClientVersionRouter } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const client = new Client({
    name: 'version-router-client-example',
    version: '1.0.0'
});

// The router wraps the client and handles era detection
const router = new StdioClientVersionRouter(client);

// Connect — router probes server/discover, falls back to initialize
const transport = new StdioClientTransport({
    command: 'node',
    args: ['path/to/server.js']
});
await router.connect(transport);

console.log(`Connected in ${router.era} mode`);

// Use client normally — works the same regardless of era
const { tools } = await client.listTools();
console.log(
    'Available tools:',
    tools.map(t => t.name)
);

if (tools.length > 0) {
    const result = await client.callTool({
        name: tools[0]!.name,
        arguments: { name: 'World' }
    });
    console.log('Tool result:', result);
}

await router.close();
