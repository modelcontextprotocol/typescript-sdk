/**
 * Custom (non-spec) method example: a server that handles a vendor-prefixed
 * `acme/search` request and emits `acme/searchProgress` notifications.
 *
 * Spawned via stdio by `examples/client/src/customMethodExample.ts`; do not run standalone.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';

const SearchParams = z.object({ query: z.string(), limit: z.number().int().default(10) });
const SearchResult = z.object({ items: z.array(z.string()) });

const mcp = new McpServer({ name: 'acme-search', version: '0.0.0' });

mcp.server.setRequestHandler('acme/search', { params: SearchParams, result: SearchResult }, async (params, ctx) => {
    await ctx.mcpReq.notify({ method: 'acme/searchProgress', params: { stage: 'start', pct: 0 } });
    const items = Array.from({ length: params.limit }, (_, i) => `${params.query}-${i}`);
    await ctx.mcpReq.notify({ method: 'acme/searchProgress', params: { stage: 'done', pct: 1 } });
    return { items };
});

await mcp.connect(new StdioServerTransport());
