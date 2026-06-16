/**
 * Dual-era stdio serving with `eraSupport: 'dual-era'`: one server process,
 * one long-lived pipe, both protocol eras.
 *
 * The same construction backs both legs — nothing about the transport or the
 * tool changes per era:
 *
 * - a plain 2025 client connects with the `initialize` handshake and is served
 *   exactly as today;
 * - a 2026-capable client (`versionNegotiation: { mode: 'auto' }`) negotiates
 *   the 2026-07-28 revision via `server/discover` on the same pipe and is
 *   served on the modern era, message by message.
 *
 * Opting in is the single `eraSupport` option; the default (`'legacy'`)
 * preserves today's behavior exactly.
 *
 * Run with `tsx examples/server/src/dualEraStdio.ts` (or point any stdio MCP
 * client at it). `examples/client/src/dualEraStdioClient.ts` drives both legs
 * against the built version of this file.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

// One construction for both legs: tools are defined once and served
// identically to 2025-era and 2026-era clients.
const buildServer = () => {
    const server = new McpServer(
        {
            name: 'dual-era-stdio-server',
            version: '1.0.0'
        },
        {
            capabilities: { tools: {} },
            instructions: 'A small dual-era stdio demo server.',
            // The one declared act: serve both protocol eras on this long-lived pipe.
            eraSupport: 'dual-era'
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

const server = buildServer();
// The transport is unchanged: dual-era support is purely a server-options declaration.
await server.connect(new StdioServerTransport());
console.error('dual-era stdio server ready (serving 2025-era initialize and 2026-07-28 envelope traffic)');

const exit = async () => {
    await server.close();
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(0);
};

process.on('SIGINT', exit);
process.on('SIGTERM', exit);
