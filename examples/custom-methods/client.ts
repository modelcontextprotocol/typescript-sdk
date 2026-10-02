/**
 * Custom (non-spec) method example: a client that sends `acme/search` and
 * listens for `acme/searchProgress` notifications.
 *
 * Spawns the sibling `server.ts` over stdio by default, or connects to a
 * running endpoint under `--http <url>`. See `examples/CONTRIBUTING.md` for
 * the canonical shape.
 */
import { check, parseExampleArgs, siblingPath } from '@mcp-examples/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod/v4';

const SearchResult = z.object({ items: z.array(z.string()) });
const SearchProgressParams = z.object({ stage: z.string(), pct: z.number() });

const { transport, url, era } = parseExampleArgs();

// Vendor-prefixed methods route through both serving entries unchanged: a
// 2025 client sends the bare JSON-RPC request, a 2026-07-28 client sends it
// with the per-request envelope; `setRequestHandler` receives either.
const client = new Client(
    { name: 'custom-methods-example-client', version: '1.0.0' },
    { versionNegotiation: { mode: era === 'modern' ? 'auto' : 'legacy' } }
);

await client.connect(
    transport === 'stdio'
        ? new StdioClientTransport({ command: 'npx', args: ['-y', 'tsx', siblingPath(import.meta.url, 'server.ts')] })
        : new StreamableHTTPClientTransport(new URL(url))
);

const stages: string[] = [];
client.setNotificationHandler('acme/searchProgress', { params: SearchProgressParams }, params => {
    stages.push(params.stage);
});

const result = await client.request({ method: 'acme/search', params: { query: 'mcp', limit: 3 } }, SearchResult);
check.deepEqual(result.items, ['mcp-0', 'mcp-1', 'mcp-2']);
check.deepEqual(stages, ['start', 'done']);

await client.close();
