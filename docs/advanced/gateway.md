---
shape: how-to
---
# Gateways and worker fleets

A **gateway** — a proxy, a worker pool, any process that fronts one MCP server with many short-lived clients — probes the server once and reuses the answer for every connection after it.

## Connect with a prior discover result

`connect()` takes an optional `prior`: a cached era verdict (`PriorDiscovery`). Its modern arm, `{ kind: 'modern', discover }`, wraps a persisted `DiscoverResult` from an earlier probe — `connect()` adopts the server's advertisement directly and sends nothing on the wire.

```ts source="../../examples/guides/advanced/gateway.examples.ts#connect_prior"
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const url = new URL('http://localhost:3000/mcp');

// Probe once …
const bootstrap = new Client({ name: 'gateway', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
await bootstrap.connect(new StreamableHTTPClientTransport(url));
const persisted = JSON.stringify(bootstrap.getDiscoverResult());

// … then every other client connects with zero round trips.
const worker = new Client({ name: 'worker', version: '1.0.0' });
await worker.connect(new StreamableHTTPClientTransport(url), { prior: { kind: 'modern', discover: JSON.parse(persisted) } });
```

`worker` is connected: `callTool` works immediately, and the server has not heard from it yet.

The modern verdict is 2026-07-28+ only — see [Protocol versions](../protocol-versions.md). For a server known to be legacy, supply the negative verdict instead — see [Skip the probe for a known-legacy server](#skip-the-probe-for-a-known-legacy-server).

## Probe once at bootstrap

An `'auto'`-mode (or pinned) connect sends `server/discover` and records the answer; `getDiscoverResult()` reads it back.

```ts source="../../examples/guides/advanced/gateway.examples.ts#bootstrap_probe"
console.log(bootstrap.getDiscoverResult());
```

The recorded value is the server's whole advertisement — supported versions, capabilities, identity, instructions:

```
{
  ttlMs: 0,
  cacheScope: 'private',
  supportedVersions: [ '2026-07-28' ],
  capabilities: { tools: { listChanged: true } },
  serverInfo: { name: 'gateway-target', version: '1.0.0' },
  resultType: 'complete'
}
```

::: tip
A client on a modern-era connection can re-probe at any time: `await client.discover()` sends `server/discover` and updates `getDiscoverResult()`. On a legacy-era connection `discover()` throws (`server/discover` is not a 2025-era method) — to re-check a legacy verdict, reconnect without a `prior` under `mode: 'auto'`, as in [Caching discovery verdicts](#caching-discovery-verdicts). A default-mode connect never probes, so its `getDiscoverResult()` is `undefined` — [Protocol versions](../protocol-versions.md#pin-an-era) lists the negotiation modes.
:::

## Persist the advertisement

The value is plain JSON. Write the string to Redis, a config map, or a process-local cache; parse it back and wrap it as the modern verdict wherever a client needs it.

```ts source="../../examples/guides/advanced/gateway.examples.ts#persist_advertisement"
import type { DiscoverResult, PriorDiscovery } from '@modelcontextprotocol/client';

const discover = JSON.parse(persisted) as DiscoverResult;
const prior: PriorDiscovery = { kind: 'modern', discover };
```

Nothing about `prior` is tied to the process that probed: any client that can reach the same URL can adopt it.

## Fan out to workers

Build every replica from the same blob; the `request_count` call after them is the proof.

```ts source="../../examples/guides/advanced/gateway.examples.ts#fan_out"
const fleet = await Promise.all(
    ['worker-a', 'worker-b', 'worker-c'].map(async name => {
        const replica = new Client({ name, version: '1.0.0' });
        await replica.connect(new StreamableHTTPClientTransport(url), { prior });
        return replica;
    })
);

const proof = await worker.callTool({ name: 'request_count' });
console.log(proof.structuredContent);
```

`request_count` is a tool on this page's example server that returns how many MCP requests reached the process. Five clients are connected by now — `bootstrap`, `worker`, three replicas — and the server has answered two requests:

```
{ requests: 2 }
```

The bootstrap probe was the first request and the `request_count` call itself the second. The four `connect({ prior })` calls sent nothing.

## Reuse only within one authorization context

The advertisement is what the server returned to the credential that probed.

::: warning
Never share a persisted `DiscoverResult` across principals — key the blob on the authorization context that obtained it (a credential hash works). The server still authorizes every request, so a wider `prior` grants nothing, but it misleads client-side capability gating.
:::

## Open a listen stream when a worker needs notifications

A modern-verdict `connect({ prior })` never auto-opens a `subscriptions/listen` stream — the client is request-only until you open one yourself. (A legacy-verdict connect is an ordinary 2025-era connection: unsolicited notifications, no `listen()`.)

```ts source="../../examples/guides/advanced/gateway.examples.ts#listen_worker"
const subscription = await worker.listen({ toolsListChanged: true });
console.log(subscription.honoredFilter);
```

The server acknowledges the filter it agreed to honor:

```
{ toolsListChanged: true }
```

From here the stream behaves like any other subscription — [Subscriptions](../clients/subscriptions.md) covers the notification handlers and the close semantics.

::: info
A `listChanged` option configured on a modern-verdict client registers its handlers but stays silent: no stream opens until you call `listen()`.
:::

## Handle a stale or incompatible advertisement

A modern verdict whose `discover` shares no 2026-07-28+ revision with the client rejects with `SdkError(EraNegotiationFailed)` before anything reaches the transport.

```ts source="../../examples/guides/advanced/gateway.examples.ts#prior_stale"
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
```

The rejection happens before the transport starts, so the same `Client` connects again on the fallback path:

```
ERA_NEGOTIATION_FAILED
re-probed: 2026-07-28
```

Replace the persisted blob with the fresh `getDiscoverResult()` and the rest of the fleet recovers on its next read.

## Skip the probe for a known-legacy server

When out-of-band metadata already says the server is pre-2026 — a registry entry, an earlier connection's outcome — an `'auto'`-mode probe is a round trip that fails on every single connect. Supply the negative verdict instead: `PriorDiscovery`'s `{ kind: 'legacy' }` arm skips the probe and goes straight to the `initialize` handshake.

```ts source="../../examples/guides/advanced/gateway.examples.ts#prior_legacy"
const pinnedLegacy = new Client({ name: 'worker-e', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
await pinnedLegacy.connect(new StreamableHTTPClientTransport(url), {
    prior: { kind: 'legacy' }
});
console.log(pinnedLegacy.getProtocolEra());
```

```
legacy
```

Freshness is your responsibility: the SDK adopts whatever verdict you hand it. A stale modern verdict fails loudly at the first request, but a stale legacy verdict succeeds silently forever — an upgraded server still answers `initialize`, so nothing ever corrects it. Date cached legacy verdicts in your own storage and stop supplying them past your policy horizon; with no `prior`, the configured mode decides again (under `mode: 'auto'` the connect re-probes, so the upgrade is discovered).

## Caching discovery verdicts

The pieces above compose into the full host-side loop: probe once, cache the verdict under your own timestamp, and gate every later connect on a freshness check you control.

The first connect under `mode: 'auto'` pays one probe. Afterwards the outcome is readable on the client: `getDiscoverResult()` returns the `DiscoverResult` on a modern server, and on a connected client its absence means the era is legacy. Store that verdict together with when you stored it — the `Map` below keeps `storedAt` explicitly; in a real deployment the store does the dating for you (a Redis key TTL, where an expired read simply comes back empty, or a database row's `created_at` column).

Before each connect, supply the cached verdict only while your own policy says it is fresh — a fixed horizon here, any predicate in practice. Supplying `undefined` under `mode: 'auto'` *is* the re-probe, and the fresh outcome re-populates the cache. The timestamp matters most for the legacy branch: a stale legacy verdict succeeds silently forever (an upgraded server still answers `initialize`), so only the timestamp ever retires it; a stale modern verdict fails loudly at the first request.

```ts source="../../examples/guides/advanced/gateway.examples.ts#prior_cache"
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
```

```
probes after first connect: 1
probes after second connect: 1
probes after the horizon passes: 2
```

The wire trace shows the shape of the loop: one probe to fill the cache, none while the verdict is fresh, one more when the horizon forces rediscovery.

## Recap

- `connect(transport, { prior: { kind: 'modern', discover } })` adopts a persisted `DiscoverResult` with zero round trips.
- The advertisement comes from one `'auto'`-mode or pinned probe — or an explicit `client.discover()` — and `getDiscoverResult()` reads it back.
- The value is plain JSON: stringify it into a shared cache, parse it back and wrap it as the modern verdict in any process that fronts the same server.
- Reuse a `DiscoverResult` only across clients that present the same authorization context.
- Modern-verdict clients are request-only; call `listen()` on the one that needs notifications.
- An incompatible `prior` rejects with `SdkError(EraNegotiationFailed)`; fall back to a fresh probe and re-persist.
- A known-legacy server takes `prior: { kind: 'legacy' }` — no probe, straight to `initialize`. Stale legacy verdicts fail silently (an upgraded server still answers `initialize`), so date them in your own storage and stop supplying them past your policy horizon.
