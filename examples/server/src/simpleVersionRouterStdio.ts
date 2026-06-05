/**
 * Demonstrates: McpServer + StdioVersionRouter
 *
 * Supports both 2025-11 (legacy) and 2026-06 (modern) clients on stdio.
 * Legacy clients use the initialize handshake. Modern clients use
 * server/discover + per-request _meta.
 */

import { McpServer, StdioVersionRouter } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

// 1. Create the server and register tools (same as without routing)
const server = new McpServer({
    name: 'version-router-stdio-example',
    version: '1.0.0'
});

server.registerTool(
    'greet',
    {
        description: 'Returns a greeting',
        inputSchema: z.object({ name: z.string() })
    },
    async ({ name }) => ({
        content: [{ type: 'text', text: `Hello, ${name}!` }]
    })
);

server.registerTool(
    'add',
    {
        description: 'Adds two numbers',
        inputSchema: z.object({ a: z.number(), b: z.number() })
    },
    async ({ a, b }) => ({
        content: [{ type: 'text', text: `${a} + ${b} = ${a + b}` }]
    })
);

// 2. Create the version router (handles both protocol eras)
const router = new StdioVersionRouter(server);

// 3. Serve on stdio — the router dispatches modern requests directly
//    and creates a legacy session for initialize-based clients.
const transport = new StdioServerTransport();
await router.serve(transport);
