/**
 * Custom (non-spec) method example: a client that sends `acme/search` and
 * listens for `acme/searchProgress` notifications.
 *
 * Build `examples/server` first; this client spawns the server via stdio.
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod/v4';

const SearchResult = z.object({ items: z.array(z.string()) });
const SearchProgressParams = z.object({ stage: z.string(), pct: z.number() });

const client = new Client({ name: 'acme-search-client', version: '0.0.0' });

client.setNotificationHandler('acme/searchProgress', { params: SearchProgressParams }, params => {
    console.log(`[progress] ${params.stage} ${Math.round(params.pct * 100)}%`);
});

await client.connect(new StdioClientTransport({ command: 'node', args: ['../server/dist/customMethodExample.js'] }));

const result = await client.request({ method: 'acme/search', params: { query: 'mcp', limit: 3 } }, SearchResult);
console.log('items:', result.items);

await client.close();
