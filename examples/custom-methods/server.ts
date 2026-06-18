/**
 * Custom (non-spec) method example: a server that handles a vendor-prefixed
 * `acme/search` request and emits `acme/searchProgress` notifications.
 *
 * One binary, either transport (selected by the shared scaffold from argv).
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

import { runServerFromArgs } from '../harness.js';

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

runServerFromArgs(buildServer);
