/**
 * Hosting on Hono / web-standard runtimes (Cloudflare Workers, Deno, Bun,
 * Node.js via `@hono/node-server`).
 *
 * `createMcpHandler(...).fetch` is the web-standard face: pass the raw
 * `Request` and return the `Response`. The `@modelcontextprotocol/hono`
 * package adds the same DNS-rebinding / origin protection middleware the
 * Express adapter ships.
 */
import { serve } from '@hono/node-server';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'hono-example', version: '1.0.0' });
    server.registerTool(
        'greet',
        { title: 'Greeting Tool', description: 'A simple greeting tool', inputSchema: z.object({ name: z.string() }) },
        async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}! (from Hono + createMcpHandler.fetch)` }] })
    );
    return server;
});

// `createMcpHonoApp()` arms localhost host/origin validation by default.
const app = createMcpHonoApp();
app.get('/health', c => c.json({ status: 'ok' }));
app.all('/mcp', c => handler.fetch(c.req.raw));

const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
const port = portIdx === -1 ? Number(process.env.MCP_PORT ?? 3000) : Number(argv[portIdx + 1]);
console.error(`hono example server listening on http://127.0.0.1:${port}/mcp`);
serve({ fetch: app.fetch, port });
