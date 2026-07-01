/**
 * Runnable, type-checked companion for `docs/advanced/gateway.md`.
 *
 * Each `//#region` block is synced byte-for-byte into that page's code fences
 * (`pnpm sync:snippets --check` reports drift).
 *
 * The page's program runs for real: the harness below builds a
 * `createMcpHandler` server and routes `globalThis.fetch` for
 * `http://localhost:3000/mcp` into `handler.fetch`, so the HTTP regions
 * execute in-process without binding a port. The output the page quotes
 * verbatim is whatever this file prints. The server's `request_count` tool
 * returns how many MCP requests reached the process (`createMcpHandler`
 * builds one server instance per request), which is what proves that
 * `connect({ prior })` sent nothing.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/advanced/gateway.examples.ts        # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

// ---------------------------------------------------------------------------
// Harness (not shown on the page). Every `new McpServer(...)` is one inbound
// MCP request, so the module-level counter is the number of requests the
// process has answered — `request_count` exposes it to the page's clients.
// ---------------------------------------------------------------------------

let requests = 0;

const handler = createMcpHandler(() => {
    requests++;
    const server = new McpServer({ name: 'gateway-target', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
    server.registerTool('echo', { description: 'Echo the input back', inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
        content: [{ type: 'text', text }]
    }));
    server.registerTool(
        'request_count',
        { description: 'Number of MCP requests this server process has answered', outputSchema: z.object({ requests: z.number() }) },
        async () => ({ content: [{ type: 'text', text: String(requests) }], structuredContent: { requests } })
    );
    return server;
});

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).host === 'localhost:3000') return handler.fetch(request);
    return realFetch(input, init);
}) as typeof fetch;

// ## Connect with a prior discover result

//#region connect_prior
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const url = new URL('http://localhost:3000/mcp');

// Probe once …
const bootstrap = new Client({ name: 'gateway', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
await bootstrap.connect(new StreamableHTTPClientTransport(url));
const persisted = JSON.stringify(bootstrap.getDiscoverResult());

// … then every other client connects with zero round trips.
const worker = new Client({ name: 'worker', version: '1.0.0' });
await worker.connect(new StreamableHTTPClientTransport(url), { prior: JSON.parse(persisted) });
//#endregion connect_prior

// ## Probe once at bootstrap

//#region bootstrap_probe
console.log(bootstrap.getDiscoverResult());
//#endregion bootstrap_probe

// ## Persist the advertisement

//#region persist_advertisement
import type { DiscoverResult } from '@modelcontextprotocol/client';

const prior = JSON.parse(persisted) as DiscoverResult;
//#endregion persist_advertisement

// ## Fan out to workers

//#region fan_out
const fleet = await Promise.all(
    ['worker-a', 'worker-b', 'worker-c'].map(async name => {
        const replica = new Client({ name, version: '1.0.0' });
        await replica.connect(new StreamableHTTPClientTransport(url), { prior });
        return replica;
    })
);

const proof = await worker.callTool({ name: 'request_count' });
console.log(proof.structuredContent);
//#endregion fan_out

// ## Open a listen stream when a worker needs notifications

//#region listen_worker
const subscription = await worker.listen({ toolsListChanged: true });
console.log(subscription.honoredFilter);
//#endregion listen_worker

await subscription.close();

// ## Handle a stale or incompatible advertisement

//#region prior_stale
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';

const stale: DiscoverResult = { ...prior, supportedVersions: ['2025-06-18'] };

const late = new Client({ name: 'worker-d', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
try {
    await late.connect(new StreamableHTTPClientTransport(url), { prior: stale });
} catch (error) {
    if (!(error instanceof SdkError) || error.code !== SdkErrorCode.EraNegotiationFailed) throw error;
    console.log(error.code);

    // Fall back to a fresh probe, then re-persist getDiscoverResult().
    await late.connect(new StreamableHTTPClientTransport(url));
    console.log('re-probed:', late.getNegotiatedProtocolVersion());
}
//#endregion prior_stale

// ---------------------------------------------------------------------------
// Harness teardown.
// ---------------------------------------------------------------------------

for (const client of [bootstrap, worker, late, ...fleet]) await client.close();
await handler.close();
globalThis.fetch = realFetch;
