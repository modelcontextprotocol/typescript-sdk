/**
 * Runnable, type-checked companion for `docs/clients/caching.md`.
 *
 * Each `//#region` block is synced byte-for-byte into that page's code fences by
 * `pnpm sync:snippets` (`pnpm sync:snippets --check` reports drift).
 *
 * The page's main program runs for real: a hint-sending `McpServer` is served
 * by `createMcpHandler` and the client's transport `fetch` is routed into
 * `handler.fetch`, so a real 2026-07-28 Streamable HTTP exchange runs
 * in-process without binding a port. The harness counts the JSON-RPC requests
 * that actually reach the server; the counts the page quotes verbatim are
 * whatever this file prints. It throws (non-zero exit) if a cache-served call
 * reaches the server.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/clients/caching.examples.ts        # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
import type { ResponseCacheStore } from '@modelcontextprotocol/client';
import { Client, InMemoryResponseCacheStore, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

// ---------------------------------------------------------------------------
// ## Have the server send the hint
// The factory body carries the page's server-side region. `createMcpHandler`
// (the harness) serves it; the tool and resource give the cache something to
// hold.
// ---------------------------------------------------------------------------

const handler = createMcpHandler(() => {
    //#region cacheHints_server
    const server = new McpServer(
        { name: 'catalog', version: '1.0.0' },
        {
            cacheHints: {
                'tools/list': { ttlMs: 60_000, cacheScope: 'public' },
                'resources/read': { ttlMs: 5_000, cacheScope: 'private' }
            }
        }
    );
    //#endregion cacheHints_server

    server.registerTool('search', { description: 'Search the product catalog' }, async () => ({
        content: [{ type: 'text', text: 'Espresso cup\nTravel mug\nMug rack' }]
    }));

    server.registerResource('app-config', 'config://app', { mimeType: 'application/json' }, async uri => ({
        contents: [{ uri: uri.href, mimeType: 'application/json', text: '{"theme":"dark"}' }]
    }));

    return server;
});

// ---------------------------------------------------------------------------
// Harness (not shown on the page). The transport's `fetch` is routed into
// `handler.fetch` — [Test a server](docs/testing.md) wiring — and counts
// every JSON-RPC request that reaches the server.
// ---------------------------------------------------------------------------

const reached = new Map<string, number>();

const transport = new StreamableHTTPClientTransport(new URL('http://caching.example/mcp'), {
    fetch: (url, init) => {
        if (typeof init?.body === 'string') {
            const message = JSON.parse(init.body) as { method?: string };
            if (typeof message.method === 'string') reached.set(message.method, (reached.get(message.method) ?? 0) + 1);
        }
        return handler.fetch(new Request(url, init));
    }
});

const client = new Client(
    { name: 'caching-docs-harness', version: '1.0.0' },
    // Cache hints ride the 2026-07-28 revision — see docs/protocol-versions.md.
    { versionNegotiation: { mode: 'auto' } }
);

await client.connect(transport);

// ## Let the cache work — the calls whose request counts the page quotes.

//#region responseCache_use
const tools = await client.listTools(); // network, then cached for the server's ttlMs
const again = await client.listTools(); // served from cache while still fresh

await client.listTools(undefined, { cacheMode: 'refresh' }); // always refetch and re-store
await client.readResource({ uri: 'config://app' }, { cacheMode: 'bypass' }); // no cache read or write
//#endregion responseCache_use

console.log('tools/list requests that reached the server:', reached.get('tools/list'));
console.log('resources/read requests that reached the server:', reached.get('resources/read'));

// Self-verification: the page claims the second listTools() made no round trip
// (two tools/list requests total: the first call and the 'refresh') and that
// the cached result carries the same tools.
if (reached.get('tools/list') !== 2 || reached.get('resources/read') !== 1) {
    throw new Error(`caching.md claim failed: tools/list=${reached.get('tools/list')}, resources/read=${reached.get('resources/read')}`);
}
if (again.tools.map(tool => tool.name).join() !== tools.tools.map(tool => tool.name).join()) {
    throw new Error('caching.md claim failed: cached listTools() differs from the first result');
}

await client.close();
await handler.close();

// ---------------------------------------------------------------------------
// The remaining regions configure a Client; they typecheck but never connect
// (each would need its own server), so they live in wrapper functions that are
// never called.
// ---------------------------------------------------------------------------

// ## Bring your own store

function responseCacheStore_shared() {
    //#region responseCacheStore_shared
    const store = new InMemoryResponseCacheStore({ maxEntries: 2048 });

    const client = new Client({ name: 'my-client', version: '1.0.0' }, { responseCacheStore: store });
    //#endregion responseCacheStore_shared
    return client;
}

// ## Partition the store per user

function cachePartition_perUser(sharedStore: ResponseCacheStore, userId: string) {
    //#region cachePartition_perUser
    const client = new Client({ name: 'gateway', version: '1.0.0' }, { responseCacheStore: sharedStore, cachePartition: userId });
    //#endregion cachePartition_perUser
    return client;
}

// ## Cache against servers that send no hints

function defaultCacheTtlMs_optIn() {
    //#region defaultCacheTtlMs_optIn
    const client = new Client({ name: 'my-client', version: '1.0.0' }, { defaultCacheTtlMs: 60_000 });
    //#endregion defaultCacheTtlMs_optIn
    return client;
}

void responseCacheStore_shared;
void cachePartition_perUser;
void defaultCacheTtlMs_optIn;
