---
status: scaffold
shape: how-to
---
# Gateways and worker fleets

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Zero-round-trip reconnect with a prior discover result.
teaches: ConnectOptions.prior, DiscoverResult, Client.getDiscoverResult, Client.discover, versionNegotiation mode 'auto', SdkErrorCode.EraNegotiationFailed, Client.listen
source: mined from docs/client.md "Skipping the probe: connect({ prior })" and "Protocol version negotiation (2026-07-28 revision)"; examples/gateway/
-->

## Connect with a prior discover result
<!-- teaches: connect(transport, { prior }) adopts a persisted DiscoverResult with zero round trips | salvage: docs/client.md "Skipping the probe: connect({ prior })" -->
A fleet that already knows the server's advertisement never has to probe again: pass it as `prior` and `connect()` sends nothing on the wire.

```ts
// draft - API verified against packages/client/src/client/client.ts (ConnectOptions.prior, getDiscoverResult) and packages/client/src/index.ts (Client, StreamableHTTPClientTransport, DiscoverResult)
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const url = new URL('https://api.example.com/mcp');

// Probe once (here via the 'auto'-mode connect), persist the result …
const bootstrap = new Client({ name: 'gateway', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
await bootstrap.connect(new StreamableHTTPClientTransport(url));
const persisted = JSON.stringify(bootstrap.getDiscoverResult());

// … then every worker connects with zero round trips.
const worker = new Client({ name: 'worker', version: '1.0.0' });
await worker.connect(new StreamableHTTPClientTransport(url), { prior: JSON.parse(persisted) });
```
<!-- result: worker.callTool works immediately; the server sees no extra discover or initialize -->

## Probe once at bootstrap
<!-- teaches: where a DiscoverResult comes from — an 'auto'/pinned connect or an explicit client.discover(); getDiscoverResult() reads it back | salvage: docs/client.md "Protocol version negotiation (2026-07-28 revision)" -->
<!-- code: bootstrap.getDiscoverResult() after the auto-mode connect -->

## Persist the advertisement
<!-- teaches: DiscoverResult round-trips through JSON.stringify/JSON.parse by design — Redis, a config map, a process-local cache | salvage: examples/gateway/client.ts steps 2-3 -->
<!-- code: redis.set(key, JSON.stringify(discovered)); later JSON.parse(await redis.get(key)) as DiscoverResult -->

## Fan out to workers
<!-- teaches: every worker connects { prior } from the same blob; capabilities, serverInfo, instructions and the negotiated version are adopted directly | salvage: examples/gateway/client.ts step 3 -->
<!-- code: workers.map(name => new Client({ name, version }).connect(transport, { prior })) -->

## Reuse only within one authorization context
<!-- teaches: the advertisement is what the server returned for the bootstrap credential — never share a DiscoverResult across principals | salvage: examples/gateway/client.ts security note -->
<!-- code: none — ::: warning aside; the rule is the content -->

## Open a listen stream when a worker needs notifications
<!-- teaches: connect({ prior }) never auto-opens subscriptions/listen; prior-connected workers are request-only until you call client.listen(filter) | salvage: docs/client.md "Skipping the probe: connect({ prior })" final paragraph -->
<!-- code: await worker.listen({ tools: {} }) on the one worker that watches for changes -->

## Handle a stale or incompatible advertisement
<!-- teaches: connect({ prior }) is 2026-07-28+ only and rejects with SdkError(EraNegotiationFailed) when no modern version is shared; re-probe and re-persist on that path | salvage: docs/client.md "Skipping the probe: connect({ prior })" -->
<!-- code: catch SdkError, check error.code === SdkErrorCode.EraNegotiationFailed, fall back to a fresh probe -->

## Recap
<!-- the claims this page will prove:
* connect(transport, { prior }) adopts a persisted DiscoverResult with zero round trips.
* The advertisement comes from one bootstrap probe ('auto'/pinned connect or client.discover()) and JSON-round-trips by design.
* Workers on the prior path are request-only; call listen() yourself if one needs notifications.
* Never reuse a DiscoverResult across authorization contexts.
* An incompatible prior rejects with EraNegotiationFailed — fall back to a fresh probe.
-->
