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
import { McpServer } from '@modelcontextprotocol/server';

import { runServerFromArgs } from '../harness.js';

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
        async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: '{"feature":true}' }] })
    );

    // A tool, so tools/list has something to cache.
    server.registerTool('noop', { description: 'no-op' }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));

    return server;
}

runServerFromArgs(buildServer);
