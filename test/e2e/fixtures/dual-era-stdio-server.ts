/**
 * Runnable dual-era stdio MCP server fixture for the dual-era stdio e2e cells.
 *
 * `eraSupport: 'dual-era'` is the single declared act on an otherwise ordinary
 * hand-constructed McpServer connected to the unchanged StdioServerTransport.
 * Spawned as a real child process (via tsx) by
 * test/e2e/scenarios/stdio-dual-era.test.ts; exits when its stdin reaches EOF.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';

const server = new McpServer(
    { name: 'dual-era-stdio-e2e-fixture', version: '1.0.0' },
    { capabilities: { tools: {} }, eraSupport: 'dual-era' }
);

server.registerTool(
    'echo',
    {
        description: 'Echoes the input text back as a text content block.',
        inputSchema: z.object({ text: z.string() })
    },
    ({ text }) => ({ content: [{ type: 'text', text }] })
);

await server.connect(new StdioServerTransport());
process.stderr.write('[dual-era-stdio-server] ready\n');
