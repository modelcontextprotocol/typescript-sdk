/**
 * The minimal `createMcpHandler` deployment, on its default posture.
 *
 * One factory, one endpoint: 2026-07-28 traffic is served per request, and
 * 2025-era (non-envelope) traffic is served stateless from the same factory
 * (`legacy: 'stateless'`, the default). This replaces the hand-wired
 * "new transport + new server per POST" stateless idiom of the 1.x SDK with
 * a one-liner.
 *
 * HTTP-only — `createMcpHandler`'s `legacy: 'stateless'` posture is an HTTP
 * hosting concern; a stdio leg would bypass it. See `dual-era/` for the stdio
 * analogue.
 */
import { serve } from '@hono/node-server';
import { parseExampleArgs } from '@mcp-examples/shared';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

function buildServer(): McpServer {
    const server = new McpServer({ name: 'stateless-legacy-example', version: '1.0.0' }, { capabilities: { logging: {} } });
    server.registerTool(
        'greet',
        { description: 'A simple greeting tool', inputSchema: z.object({ name: z.string() }) },
        async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}!` }] })
    );
    return server;
}

const { port } = parseExampleArgs();

const handler = createMcpHandler(buildServer);
// `createMcpHonoApp()` binds the endpoint behind localhost host/origin
// validation by default, matching the framework factories' defaults.
const app = createMcpHonoApp();
app.all('/mcp', c => handler.fetch(c.req.raw));
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
    console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
});
