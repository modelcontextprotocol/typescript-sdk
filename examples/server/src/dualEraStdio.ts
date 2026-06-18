/**
 * Dual-era stdio serving with `serveStdio`: one server process, both protocol
 * eras, one factory.
 *
 * The entry owns the era decision per connection: the client's opening
 * exchange selects the era, one instance from the factory is pinned for the
 * connection lifetime, and that instance serves only that era.
 *
 * - a plain 2025 client connects with the `initialize` handshake and is served
 *   by a 2025-era instance exactly as today;
 * - a 2026-capable client (`versionNegotiation: { mode: 'auto' }`) probes with
 *   `server/discover`, negotiates the 2026-07-28 revision, and is served by a
 *   2026-era instance — every request carrying the per-request `_meta`
 *   envelope.
 *
 * The same factory backs both: tools are defined once and served identically
 * to either kind of client.
 *
 * Run with `tsx examples/server/src/dualEraStdio.ts` (or point any stdio MCP
 * client at it). `examples/client/src/dualEraStdioClient.ts` drives both legs
 * against this file.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

// One factory for both eras: tools are defined once and served identically to
// 2025-era and 2026-era clients. The entry constructs one instance per
// connection, for the era that connection's client opened with.
const buildServer = () => {
    const server = new McpServer(
        {
            name: 'dual-era-stdio-server',
            version: '1.0.0'
        },
        {
            capabilities: { tools: {} },
            instructions: 'A small dual-era stdio demo server.'
        }
    );

    server.registerTool(
        'greet',
        {
            description: 'Greets the caller',
            inputSchema: z.object({ name: z.string().describe('Name to greet') })
        },
        async ({ name }): Promise<CallToolResult> => ({
            content: [{ type: 'text', text: `Hello, ${name}!` }]
        })
    );

    return server;
};

// The entry owns the stdio transport and the era decision; 2025-era clients
// are served by default (`legacy: 'serve'`).
const handle = serveStdio(buildServer);
console.error('dual-era stdio server ready (serving 2025-era initialize and 2026-07-28 envelope traffic)');

const exit = async () => {
    await handle.close();
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(0);
};

process.on('SIGINT', exit);
process.on('SIGTERM', exit);
