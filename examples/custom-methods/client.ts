/**
 * Custom (non-spec) method example: a client that sends `acme/search` and
 * listens for `acme/searchProgress` notifications.
 *
 * The client spawns the sibling server straight from source over stdio (no
 * build step), or connects to a running endpoint under `--http <url>`.
 */
import { z } from 'zod/v4';

import { check, connectFromArgs, runClient } from '../harness.js';

const SearchResult = z.object({ items: z.array(z.string()) });
const SearchProgressParams = z.object({ stage: z.string(), pct: z.number() });

runClient('custom-methods', async () => {
    // Custom methods carry no envelope semantics — connect as a plain 2025
    // client so the request reaches the server's setRequestHandler exactly as
    // a hand-wired stdio client would.
    // connectFromArgs picks transport (default: spawn ./server.ts over stdio; --http <url>) and era (--legacy) from argv. Your code would construct a Client and connect over your chosen transport directly.
    const client = await connectFromArgs(import.meta.dirname, { versionNegotiation: undefined });

    const stages: string[] = [];
    client.setNotificationHandler('acme/searchProgress', { params: SearchProgressParams }, params => {
        stages.push(params.stage);
    });

    const result = await client.request({ method: 'acme/search', params: { query: 'mcp', limit: 3 } }, SearchResult);
    check.deepEqual(result.items, ['mcp-0', 'mcp-1', 'mcp-2']);
    check.deepEqual(stages, ['start', 'done']);

    await client.close();
});
