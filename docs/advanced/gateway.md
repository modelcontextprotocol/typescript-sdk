---
shape: how-to
---
# Gateways and worker fleets

A **gateway** — a proxy, a worker pool, any process that fronts one MCP server with many short-lived clients — probes the server once and reuses the answer for every connection after it.

## Connect with a prior discover result

`connect()` takes an optional `prior`: a persisted `DiscoverResult` from an earlier probe. With it, `connect()` adopts the server's advertisement directly and sends nothing on the wire.

```ts source="../../examples/guides/advanced/gateway.examples.ts#connect_prior"
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const url = new URL('http://localhost:3000/mcp');

// Probe once …
const bootstrap = new Client({ name: 'gateway', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
await bootstrap.connect(new StreamableHTTPClientTransport(url));
const persisted = JSON.stringify(bootstrap.getDiscoverResult());

// … then every other client connects with zero round trips.
const worker = new Client({ name: 'worker', version: '1.0.0' });
await worker.connect(new StreamableHTTPClientTransport(url), { prior: JSON.parse(persisted) });
```

`worker` is connected: `callTool` works immediately, and the server has not heard from it yet.

`connect({ prior })` is 2026-07-28+ only — see [Protocol versions](../protocol-versions.md).

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
An already-connected client can re-probe at any time: `await client.discover()` sends `server/discover` and updates `getDiscoverResult()`. A default-mode connect never probes, so its `getDiscoverResult()` is `undefined` — [Protocol versions](../protocol-versions.md#pin-an-era) lists the negotiation modes.
:::

## Persist the advertisement

The value is plain JSON. Write the string to Redis, a config map, or a process-local cache; parse it back wherever a client needs it.

```ts source="../../examples/guides/advanced/gateway.examples.ts#persist_advertisement"
import type { DiscoverResult } from '@modelcontextprotocol/client';

const prior = JSON.parse(persisted) as DiscoverResult;
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

`connect({ prior })` never auto-opens a `subscriptions/listen` stream — prior-connected clients are request-only until you open one yourself.

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
A `listChanged` option configured on a prior-connected client registers its handlers but stays silent: no stream opens until you call `listen()`.
:::

## Handle a stale or incompatible advertisement

A `prior` that shares no 2026-07-28+ revision with the client rejects with `SdkError(EraNegotiationFailed)` before anything reaches the transport.

```ts source="../../examples/guides/advanced/gateway.examples.ts#prior_stale"
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
```

The rejection happens before the transport starts, so the same `Client` connects again on the fallback path:

```
ERA_NEGOTIATION_FAILED
re-probed: 2026-07-28
```

Replace the persisted blob with the fresh `getDiscoverResult()` and the rest of the fleet recovers on its next read.

## Recap

- `connect(transport, { prior })` adopts a persisted `DiscoverResult` with zero round trips.
- The advertisement comes from one `'auto'`-mode or pinned probe — or an explicit `client.discover()` — and `getDiscoverResult()` reads it back.
- The value is plain JSON: stringify it into a shared cache, parse it in any process that fronts the same server.
- Reuse a `DiscoverResult` only across clients that present the same authorization context.
- Prior-connected clients are request-only; call `listen()` on the one that needs notifications.
- An incompatible `prior` rejects with `SdkError(EraNegotiationFailed)`; fall back to a fresh probe and re-persist.
