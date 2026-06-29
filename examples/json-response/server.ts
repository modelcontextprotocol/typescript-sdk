/**
 * `createMcpHandler` with `responseMode: 'json'` — single JSON response
 * instead of an SSE stream. Useful for serverless deployments that can't
 * hold a stream open. Mid-call notifications are dropped (the handler logs a
 * warning at construction time).
 *
 * HTTP-only — `responseMode` shapes the HTTP response body; there is no stdio
 * equivalent and a stdio leg would not exercise the option.
 */
import { createServer } from 'node:http';

import { parseExampleArgs } from '@mcp-examples/shared';
import { toNodeHandler } from '@modelcontextprotocol/node';
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
createServer(toNodeHandler(handler)).listen(port, () => {
    console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
});
