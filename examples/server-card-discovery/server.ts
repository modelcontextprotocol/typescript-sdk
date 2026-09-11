/**
 * Server Card discovery example (experimental extension, SEP-2127): an MCP
 * endpoint that also serves its Server Card at `/mcp/server-card` and an AI
 * Catalog at `/.well-known/ai-catalog.json`, so clients can discover it from
 * the domain alone.
 *
 * HTTP only — cards describe remote servers. Start with `--http --port <N>`.
 */
import { serve } from '@hono/node-server';
import { parseExampleArgs } from '@mcp-examples/shared';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import {
    aiCatalogResponse,
    buildAICatalog,
    buildServerCard,
    getServerCardUrl,
    serverCardCatalogEntry,
    serverCardResponse
} from '@modelcontextprotocol/server/experimental/server-card';
import { z } from 'zod/v4';

const serverInfo = { name: 'com.example/weather', version: '1.0.0' };

function buildServer(): McpServer {
    const mcp = new McpServer(serverInfo);
    mcp.registerTool('forecast', { inputSchema: z.object({ city: z.string() }) }, ({ city }) => ({
        content: [{ type: 'text', text: `Sunny in ${city}` }]
    }));
    return mcp;
}

const { transport, port } = parseExampleArgs();
if (transport !== 'http') {
    throw new Error('this story is HTTP-only; start with --http --port <N>');
}

const mcpUrl = new URL(`http://127.0.0.1:${port}/mcp`);
// Built once at startup: an invalid card is a boot error, never a broken
// production document.
const card = buildServerCard({
    name: 'com.example/weather',
    description: 'Hourly and 7-day forecasts for any coordinates',
    serverInfo,
    remotes: [{ type: 'streamable-http', url: mcpUrl.href }]
});
const catalog = buildAICatalog({
    entries: [serverCardCatalogEntry(card, { url: getServerCardUrl(mcpUrl) })]
});

const handler = createMcpHandler(buildServer);
serve(
    {
        fetch: async (request: Request): Promise<Response> =>
            (await (serverCardResponse(request, { card, mcpUrl }) ?? aiCatalogResponse(request, { catalog }))) ?? handler.fetch(request),
        port,
        hostname: '127.0.0.1'
    },
    () => {
        console.error(`[server] listening on ${mcpUrl.href} (card at ${getServerCardUrl(mcpUrl)})`);
    }
);
