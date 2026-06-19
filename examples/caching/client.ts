/**
 * Reads the cache hints emitted on cacheable results (2026-07-28 connections
 * only) and asserts the configured values reached the wire. Full client-side
 * cache *honouring* (re-using a fresh result instead of re-requesting) is a
 * follow-up — see the SDK's tracking issue for client cache support.
 */
import { check, connectFromArgs, runClient } from '../harness.js';

interface Cacheable {
    ttlMs?: number;
    cacheScope?: 'public' | 'private';
}

runClient('caching', async () => {
    // connectFromArgs picks transport (default: spawn ./server.ts over stdio; --http <url>) and era (--legacy) from argv. Your code would construct a Client and connect over your chosen transport directly.
    const client = await connectFromArgs(import.meta.dirname);
    check.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');

    const tools = (await client.listTools()) as Cacheable & Awaited<ReturnType<typeof client.listTools>>;
    check.equal(tools.ttlMs, 30_000);
    check.equal(tools.cacheScope, 'public');

    const resources = (await client.listResources()) as Cacheable & Awaited<ReturnType<typeof client.listResources>>;
    check.equal(resources.ttlMs, 5000);
    check.equal(resources.cacheScope, 'public');

    const read = (await client.readResource({ uri: 'config://app' })) as Cacheable & Awaited<ReturnType<typeof client.readResource>>;
    check.equal(read.ttlMs, 60_000);
    check.equal(read.cacheScope, 'private');

    await client.close();
});
