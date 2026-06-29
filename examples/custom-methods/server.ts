/**
 * Custom (non-spec) method example: a server that handles a vendor-prefixed
 * `acme/search` request and emits `acme/searchProgress` notifications.
 *
 * One binary, either transport — selected by `--http --port <N>` (defaults to
 * stdio). See `examples/CONTRIBUTING.md` for the canonical shape.
 */
import { createServer } from 'node:http';

import { parseExampleArgs } from '@mcp-examples/shared';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';

const SearchParams = z.object({ query: z.string(), limit: z.number().int().default(10) });
const SearchResult = z.object({ items: z.array(z.string()) });

function buildServer(): McpServer {
    const mcp = new McpServer({ name: 'acme-search', version: '0.0.0' });

    mcp.server.setRequestHandler('acme/search', { params: SearchParams, result: SearchResult }, async (params, ctx) => {
        await ctx.mcpReq.notify({ method: 'acme/searchProgress', params: { stage: 'start', pct: 0 } });
        const items = Array.from({ length: params.limit }, (_, i) => `${params.query}-${i}`);
        await ctx.mcpReq.notify({ method: 'acme/searchProgress', params: { stage: 'done', pct: 1 } });
        return { items };
    });

    return mcp;
}

const { transport, port } = parseExampleArgs();

if (transport === 'stdio') {
    void serveStdio(buildServer);
    console.error('[server] serving over stdio');
} else {
    const handler = createMcpHandler(buildServer);
    createServer(toNodeHandler(handler)).listen(port, () => {
        console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
    });
}
