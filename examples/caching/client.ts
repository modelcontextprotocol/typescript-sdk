/**
 * Reads the cache hints emitted on cacheable results (2026-07-28 connections
 * only) and asserts the client honours them: a still-fresh cached entry is
 * served without a round trip.
 */
import { check, parseExampleArgs, siblingPath } from '@mcp-examples/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

interface Cacheable {
    ttlMs?: number;
    cacheScope?: 'public' | 'private';
}

async function callCount(client: Client, name: 'read-count' | 'request-count'): Promise<number> {
    const r = await client.callTool({ name });
    return Number((r.content[0] as { text: string }).text);
}

const { transport, url, era } = parseExampleArgs();

const client = new Client(
    { name: 'caching-example-client', version: '1.0.0' },
    { versionNegotiation: { mode: era === 'modern' ? 'auto' : 'legacy' } }
);

await (transport === 'stdio'
    ? client.connect(new StdioClientTransport({ command: 'npx', args: ['-y', 'tsx', siblingPath(import.meta.url, 'server.ts')] }))
    : client.connect(new StreamableHTTPClientTransport(new URL(url))));

check.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');

// The server stamps `tools/list` with `ttlMs: 30_000, cacheScope: 'public'`.
const tools = (await client.listTools()) as Cacheable & Awaited<ReturnType<typeof client.listTools>>;
check.equal(tools.ttlMs, 30_000);
check.equal(tools.cacheScope, 'public');
// `request-count` proves the wire was reached exactly once.
check.equal(await callCount(client, 'request-count'), 1);

// The second call is served from the response cache: the server-side
// `tools/list` counter is unchanged, and the result is a fresh copy of the
// held entry (so mutating it cannot reach the cache).
const toolsAgain = await client.listTools();
check.deepEqual(
    toolsAgain.tools.map(t => t.name),
    tools.tools.map(t => t.name)
);
check.equal(await callCount(client, 'request-count'), 1);

// `cacheMode: 'refresh'` always fetches and re-stores: the counter moves.
await client.listTools(undefined, { cacheMode: 'refresh' });
check.equal(await callCount(client, 'request-count'), 2);

const resources = (await client.listResources()) as Cacheable & Awaited<ReturnType<typeof client.listResources>>;
check.equal(resources.ttlMs, 5000);
check.equal(resources.cacheScope, 'public');

// `readResource`: the resource handler counts how many times it ran, and
// the `read-count` tool exposes that counter.
const read = (await client.readResource({ uri: 'config://app' })) as Cacheable & Awaited<ReturnType<typeof client.readResource>>;
check.equal(read.ttlMs, 60_000);
check.equal(read.cacheScope, 'private');
check.equal(await callCount(client, 'read-count'), 1);

// Within TTL, default `cacheMode: 'use'` → served from cache; the server
// handler does not run.
await client.readResource({ uri: 'config://app' });
check.equal(await callCount(client, 'read-count'), 1);

// `cacheMode: 'refresh'` always fetches and re-stores.
await client.readResource({ uri: 'config://app' }, { cacheMode: 'refresh' });
check.equal(await callCount(client, 'read-count'), 2);

// After the refresh the entry is fresh again — back to cache-served.
await client.readResource({ uri: 'config://app' });
check.equal(await callCount(client, 'read-count'), 2);

await client.close();
