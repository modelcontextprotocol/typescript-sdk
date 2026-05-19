/**
 * Example MCP server using Hono with the 2026-06 stateless entry point.
 *
 * This is the headline 2026-06 (SEP-2575) example: one shared McpServer
 * instance, no Transport object, no connect(). handleHttp() returns a
 * Fetch-API (Request) => Response handler that any web-standard runtime
 * can mount: Node.js, Cloudflare Workers, Deno, Bun, etc.
 *
 * Pre-2026 clients are not served by this entry. For a dual-mode setup
 * (one endpoint serving both protocols), see "Dual-mode endpoint" in the
 * 2026-06 section of `docs/migration.md`.
 *
 * Run with: pnpm tsx src/honoWebStandardStreamableHttp.ts
 */

import { serve } from '@hono/node-server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { handleHttp, McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import * as z from 'zod/v4';

// Create one shared MCP server instance. Under the 2026-06 stateless model
// there is no per-session state, so a single instance handles all requests.
const server = new McpServer({
    name: 'hono-webstandard-mcp-server',
    version: '1.0.0'
});

// Register a simple greeting tool
server.registerTool(
    'greet',
    {
        title: 'Greeting Tool',
        description: 'A simple greeting tool',
        inputSchema: z.object({ name: z.string().describe('Name to greet') })
    },
    async ({ name }): Promise<CallToolResult> => {
        return {
            content: [{ type: 'text', text: `Hello, ${name}! (from Hono + handleHttp)` }]
        };
    }
);

// handleHttp(server, opts) returns a (Request) => Promise<Response> handler.
// No Transport, no connect(); each HTTP request is dispatched independently.
const mcpHandler = handleHttp(server.server, {
    allowedHosts: ['localhost', '127.0.0.1']
});

// Create the Hono app
const app = new Hono();

// Enable CORS for all origins
app.use(
    '*',
    cors({
        origin: '*',
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'mcp-session-id', 'Last-Event-ID', 'mcp-protocol-version'],
        exposeHeaders: ['mcp-session-id', 'mcp-protocol-version']
    })
);

// Health check endpoint
app.get('/health', c => c.json({ status: 'ok' }));

// MCP endpoint
app.all('/mcp', c => mcpHandler(c.req.raw));

// Start the server
const PORT = process.env.MCP_PORT ? Number.parseInt(process.env.MCP_PORT, 10) : 3000;

console.log(`Starting Hono MCP server on port ${PORT}`);
console.log(`Health check: http://localhost:${PORT}/health`);
console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);

serve({
    fetch: app.fetch,
    port: PORT
});
