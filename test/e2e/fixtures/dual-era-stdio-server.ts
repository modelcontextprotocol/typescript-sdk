/**
 * Runnable dual-era stdio MCP server fixture for the dual-era stdio e2e cells.
 *
 * The connection-pinned `serveStdio` entry over an ordinary `McpServer`
 * factory: the client's opening exchange selects the era for the connection
 * (a 2025 `initialize` handshake or 2026-07-28 per-request envelope traffic
 * negotiated via `server/discover`), and one factory instance serves it.
 * Spawned as a real child process (via tsx) by
 * test/e2e/scenarios/stdio-dual-era.test.ts; exits when its stdin reaches EOF.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';

serveStdio(() => {
    const server = new McpServer({ name: 'dual-era-stdio-e2e-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.registerTool(
        'echo',
        {
            description: 'Echoes the input text back as a text content block.',
            inputSchema: z.object({ text: z.string() })
        },
        ({ text }) => ({ content: [{ type: 'text', text }] })
    );
    return server;
});
process.stderr.write('[dual-era-stdio-server] ready\n');
