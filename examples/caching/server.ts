/**
 * Cache hints (`CacheableResult`, protocol revision 2026-07-28).
 *
 * The 2026-07-28 revision requires `ttlMs`/`cacheScope` on the cacheable
 * result types (the list operations and `resources/read`). The values are
 * resolved most-specific-author-first:
 *
 *   1. fields the handler returns on the result itself,
 *   2. a per-registration `cacheHint` (here: the resource's read result),
 *   3. the server-level per-operation `ServerOptions.cacheHints`,
 *   4. the conservative defaults (`ttlMs: 0`, `cacheScope: 'private'`).
 *
 * The fields are emitted ONLY toward 2026-era clients — a 2025-era response
 * is byte-for-byte unchanged. One binary, either transport.
 */
import { createServer } from 'node:http';

import { parseExampleArgs } from '@mcp-examples/shared';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

// Module-level (process-wide) counters so the values survive the stateless
// HTTP leg (fresh `buildServer()` per request) as well as stdio's single
// per-connection instance. The client asserts against these to prove a
// cache-served call never reached the server.
let readCount = 0;
let listCount = 0;

function buildServer(): McpServer {
    const server = new McpServer(
        { name: 'caching-example', version: '1.0.0' },
        {
            // Server-level per-operation hints: any list/read result that does not
            // override a field gets these.
            cacheHints: {
                'resources/list': { ttlMs: 5000, cacheScope: 'public' },
                'tools/list': { ttlMs: 30_000, cacheScope: 'public' }
            }
        }
    );

    // A direct resource carrying a per-registration hint that wins for its
    // own resources/read result.
    server.registerResource(
        'app-config',
        'config://app',
        {
            mimeType: 'application/json',
            description: 'Static application config (rarely changes)',
            cacheHint: { ttlMs: 60_000, cacheScope: 'private' }
        },
        async uri => {
            readCount++;
            return { contents: [{ uri: uri.href, mimeType: 'application/json', text: '{"feature":true}' }] };
        }
    );

    // A tool, so tools/list has something to cache.
    server.registerTool('noop', { description: 'no-op' }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));

    // Exposes the server-side `resources/read` invocation count so the client
    // can assert that a cache-served call did not reach the wire.
    server.registerTool('read-count', { description: 'Number of resources/read calls that reached this server' }, async () => ({
        content: [{ type: 'text', text: String(readCount) }]
    }));

    // Exposes the server-side `tools/list` invocation count.
    server.registerTool('request-count', { description: 'Number of tools/list requests that reached this server' }, async () => ({
        content: [{ type: 'text', text: String(listCount) }]
    }));

    // Wrap the auto-generated `tools/list` handler so the example can prove a
    // cache-served `listTools()` never reached the wire. `McpServer` registers
    // the handler lazily on the first `registerTool()`; we re-seat it here so
    // every dispatch increments `listCount` before delegating to the original.
    // (Reaches the underlying request-handler map directly — there is no public
    // wrapper hook; acceptable for an instrumentation example.)
    const handlers = (server.server as unknown as { _requestHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })
        ._requestHandlers;
    const original = handlers.get('tools/list');
    if (original) {
        handlers.set('tools/list', (...a) => {
            listCount++;
            return original(...a);
        });
    }

    return server;
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
