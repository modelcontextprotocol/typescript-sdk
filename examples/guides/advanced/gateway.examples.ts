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

/** Everything the page prints, for the self-verifying asserts at teardown. */
const logged: string[] = [];
const realLog = console.log;
console.log = (...args: unknown[]): void => {
    logged.push(args.map(String).join(' '));
    realLog(...args);
};

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
await worker.connect(new StreamableHTTPClientTransport(url), { prior: { kind: 'modern', discover: JSON.parse(persisted) } });
//#endregion connect_prior

// ## Probe once at bootstrap

//#region bootstrap_probe
console.log(bootstrap.getDiscoverResult());
//#endregion bootstrap_probe

// ## Persist the advertisement

//#region persist_advertisement
import type { DiscoverResult, PriorDiscovery } from '@modelcontextprotocol/client';

const discover = JSON.parse(persisted) as DiscoverResult;
const prior: PriorDiscovery = { kind: 'modern', discover };
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

const stale: DiscoverResult = { ...discover, supportedVersions: ['2025-06-18'] };

const late = new Client({ name: 'worker-d', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
try {
    await late.connect(new StreamableHTTPClientTransport(url), { prior: { kind: 'modern', discover: stale } });
} catch (error) {
    if (!(error instanceof SdkError) || error.code !== SdkErrorCode.EraNegotiationFailed) throw error;
    console.log(error.code);

    // Fall back to a fresh probe, then re-persist getDiscoverResult().
    await late.connect(new StreamableHTTPClientTransport(url));
    console.log('re-probed:', late.getNegotiatedProtocolVersion());
}
//#endregion prior_stale

// ## Skip the probe for a known-legacy server

//#region prior_legacy
const pinnedLegacy = new Client({ name: 'worker-e', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
await pinnedLegacy.connect(new StreamableHTTPClientTransport(url), {
    prior: { kind: 'legacy' }
});
console.log(pinnedLegacy.getProtocolEra());
//#endregion prior_legacy

// ## Caching discovery verdicts

//#region prior_cache
// Host-side verdict cache. A real deployment keeps this in Redis (a key TTL
// does the dating: an expired read is no prior) or a database row with a
// created_at column; the Map stores the timestamp explicitly.
const verdicts = new Map<string, { verdict: PriorDiscovery; storedAt: number }>();
const HORIZON_MS = 24 * 60 * 60 * 1000; // fixed-horizon freshness policy
const fresh = (entry: { storedAt: number }): boolean => Date.now() - entry.storedAt < HORIZON_MS;

// Count server/discover probes at the fetch layer (the wire trace).
let probes = 0;
const tracingFetch: typeof fetch = async (input, init) => {
    if (typeof init?.body === 'string' && init.body.includes('"server/discover"')) probes++;
    return fetch(input, init);
};

async function connectCached(key: string): Promise<Client> {
    const entry = verdicts.get(key);
    // An entry past the horizon is not supplied — under mode: 'auto' that IS
    // the re-probe, and the fresh outcome below re-populates the cache.
    const prior = entry && fresh(entry) ? entry.verdict : undefined;

    const client = new Client({ name: 'cached-worker', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(url, { fetch: tracingFetch }), { prior });

    if (prior === undefined) {
        // Fresh outcome: getDiscoverResult() is the DiscoverResult on a modern
        // server; its absence on a connected client means the era is legacy.
        const discover = client.getDiscoverResult();
        // Date the entry with the host's own clock — only this timestamp ever
        // retires a legacy verdict (a stale one succeeds silently forever).
        verdicts.set(key, {
            verdict: discover ? { kind: 'modern', discover } : { kind: 'legacy' },
            storedAt: Date.now()
        });
    }
    return client;
}

const first = await connectCached('gateway-target'); // no entry: probes
console.log('probes after first connect:', probes);

const second = await connectCached('gateway-target'); // fresh entry: verdict supplied, no probe
console.log('probes after second connect:', probes);

verdicts.get('gateway-target')!.storedAt -= HORIZON_MS + 1; // the horizon passes
const third = await connectCached('gateway-target'); // stale: dropped, re-probed, re-cached
console.log('probes after the horizon passes:', probes);
//#endregion prior_cache

// ---------------------------------------------------------------------------
// Harness teardown + self-verification of the string lines the page quotes
// (object dumps stringify uselessly and are not checked here).
// ---------------------------------------------------------------------------

for (const client of [bootstrap, worker, late, pinnedLegacy, first, second, third, ...fleet]) await client.close();
await handler.close();
globalThis.fetch = realFetch;
console.log = realLog;

const mustHaveLogged = [
    'ERA_NEGOTIATION_FAILED',
    're-probed: 2026-07-28',
    'legacy',
    'probes after first connect: 1',
    'probes after second connect: 1',
    'probes after the horizon passes: 2'
];
for (const line of mustHaveLogged) {
    if (!logged.includes(line)) throw new Error(`page output mismatch: expected "${line}" in:\n${logged.join('\n')}`);
}
const recached = verdicts.get('gateway-target');
if (recached?.verdict.kind !== 'modern' || !fresh(recached)) {
    // fresh() proves storedAt was rewritten after the horizon rollback — the
    // re-probe really re-populated the cache, not just left the old entry.
    throw new Error('expected the horizon re-probe to re-populate the cache with a fresh modern verdict');
}
