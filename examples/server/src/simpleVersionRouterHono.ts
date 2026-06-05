/**
 * Demonstrates: McpServer + HttpVersionRouter with Hono (stateless)
 *
 * The modern (2026-06) path is naturally stateless — no Transport object,
 * no sessions. Each HTTP request dispatches directly to McpServer.
 * This is the version-router equivalent of the existing
 * honoWebStandardStreamableHttp.ts example.
 *
 * Run with: pnpm tsx src/simpleVersionRouterHono.ts
 */

import { serve } from '@hono/node-server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { HttpVersionRouter, McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import * as z from 'zod/v4';

const server = new McpServer({
    name: 'hono-version-router-example',
    version: '1.0.0'
});

server.registerTool(
    'greet',
    {
        title: 'Greeting Tool',
        description: 'A simple greeting tool',
        inputSchema: z.object({ name: z.string().describe('Name to greet') })
    },
    async ({ name }): Promise<CallToolResult> => ({
        content: [{ type: 'text', text: `Hello, ${name}! (from Hono + version router)` }]
    })
);

const router = new HttpVersionRouter(server);

const app = new Hono();

app.use(
    '*',
    cors({
        origin: '*',
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'mcp-method', 'mcp-protocol-version'],
        exposeHeaders: ['mcp-protocol-version']
    })
);

app.get('/health', c => c.json({ status: 'ok' }));

// Stateless MCP endpoint — no Transport, no sessions.
// handleModernRequest dispatches directly to McpServer.
// server/discover is handled automatically.
app.post('/mcp', async c => {
    const body = await c.req.json();
    try {
        const result = await router.handleModernRequest(body, {
            httpHeaders: Object.fromEntries(c.req.raw.headers.entries())
        });
        return c.json({ jsonrpc: '2.0', id: body.id, result });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Internal error';
        return c.json(
            { jsonrpc: '2.0', id: body.id, error: { code: -32_603, message } },
            500
        );
    }
});

const PORT = process.env.MCP_PORT ? Number.parseInt(process.env.MCP_PORT, 10) : 3000;

console.log(`Starting Hono MCP server on port ${PORT}`);
console.log(`Health check: http://localhost:${PORT}/health`);
console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
console.log('Modern (2026-06) only — stateless, no sessions.');

serve({ fetch: app.fetch, port: PORT });
