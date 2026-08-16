/**
 * `createMcpHandler` with `responseMode: 'json'` — single JSON response
 * instead of an SSE stream. Useful for serverless deployments that can't
 * hold a stream open. Mid-call notifications are dropped (the handler logs a
 * warning at construction time).
 *
 * HTTP-only — `responseMode` shapes the HTTP response body; there is no stdio
 * equivalent and a stdio leg would not exercise the option.
 */
import { serve } from '@hono/node-server';
import { parseExampleArgs } from '@mcp-examples/shared';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

function buildServer(): McpServer {
    const server = new McpServer({ name: 'json-response-example', version: '1.0.0' });
    server.registerTool(
        'greet',
        { description: 'A simple greeting tool', inputSchema: z.object({ name: z.string() }) },
        async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}!` }] })
    );
    return server;
}

const { port } = parseExampleArgs();

// `responseMode: 'json'` is the point of this story — applies to the modern
// (2026-07-28) per-request HTTP path.
const handler = createMcpHandler(buildServer, { responseMode: 'json' });
// `createMcpHonoApp()` binds the endpoint behind localhost host/origin
// validation by default, matching the framework factories' defaults.
const app = createMcpHonoApp();
app.all('/mcp', c => handler.fetch(c.req.raw));
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
    console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
});
