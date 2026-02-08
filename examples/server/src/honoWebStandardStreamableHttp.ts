/**
 * Example MCP server using Hono with WebStandardStreamableHTTPServerTransport
 *
 * This example demonstrates using the Web Standard transport directly with Hono,
 * which works on any runtime: Node.js, Cloudflare Workers, Deno, Bun, etc.
 *
 * Run with: pnpm tsx src/honoWebStandardStreamableHttp.ts
 */

import { serve } from '@hono/node-server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import * as z from 'zod/v4';

// Create the MCP server
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
            content: [{ type: 'text', text: `Hello, ${name}! (from Hono + WebStandard transport)` }]
        };
    }
);

// Create a stateless transport (no options = no session management)
const transport = new WebStandardStreamableHTTPServerTransport();

// Create the Hono app
const app = new Hono();

const DEFAULT_CORS_ORIGIN_REGEX = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

let corsOriginRegex = DEFAULT_CORS_ORIGIN_REGEX;
if (process.env.MCP_CORS_ORIGIN_REGEX) {
    try {
        corsOriginRegex = new RegExp(process.env.MCP_CORS_ORIGIN_REGEX);
    } catch (error) {
        const msg =
            error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : String(error);
        console.warn(`Invalid MCP_CORS_ORIGIN_REGEX (${process.env.MCP_CORS_ORIGIN_REGEX}): ${msg}`);
        corsOriginRegex = DEFAULT_CORS_ORIGIN_REGEX;
    }
}

// CORS: allow only loopback origins by default (typical for local dev / Inspector direct connect).
// If you intentionally expose this demo remotely, set MCP_CORS_ORIGIN_REGEX explicitly.
app.use(
    '*',
    cors({
        origin: (origin, _c) => {
            if (!origin) return null;
            return corsOriginRegex.test(origin) ? origin : null;
        },
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'mcp-session-id', 'Last-Event-ID', 'mcp-protocol-version'],
        exposeHeaders: ['mcp-session-id', 'mcp-protocol-version']
    })
);

// Health check endpoint
app.get('/health', c => c.json({ status: 'ok' }));

// MCP endpoint
app.all('/mcp', c => transport.handleRequest(c.req.raw));

// Start the server
const HOST = process.env.MCP_HOST ?? 'localhost';
const PORT = process.env.MCP_PORT ? Number.parseInt(process.env.MCP_PORT, 10) : 3000;

await server.connect(transport);

console.log(`Starting Hono MCP server on http://${HOST}:${PORT}`);
console.log(`Health check: http://${HOST}:${PORT}/health`);
console.log(`MCP endpoint: http://${HOST}:${PORT}/mcp`);

serve({
    fetch: app.fetch,
    hostname: HOST,
    port: PORT
});
