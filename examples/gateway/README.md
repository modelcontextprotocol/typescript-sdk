# gateway

`connect({ prior: { kind: 'modern', discover } })` — zero-round-trip connect for gateways and distributed clients (protocol revision 2026-07-28).

```bash
pnpm --filter @mcp-examples/gateway server -- --http --port 3000
pnpm --filter @mcp-examples/gateway client -- --http http://127.0.0.1:3000/
```

The 2026 protocol is **stateless on HTTP**: every request carries the per-request `_meta` envelope (protocol version, client info, client capabilities), so once you know the server's `DiscoverResult` there is nothing left to negotiate. A gateway, proxy, or worker fleet that
fronts the same server should not re-probe per worker — it probes once and every subsequent connect is free.

## The pattern

```ts
// 1. Bootstrap: probe once.
const bootstrap = new Client({ name: 'bootstrap', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
await bootstrap.connect(new StreamableHTTPClientTransport(url));
const persisted = JSON.stringify(bootstrap.getDiscoverResult()); // → write to Redis / config / process-local cache
await bootstrap.close();

// 2. Every worker: zero-round-trip connect from the persisted blob.
const worker = new Client({ name: 'worker', version: '1.0.0' });
await worker.connect(new StreamableHTTPClientTransport(url), { prior: { kind: 'modern', discover: JSON.parse(persisted) } });
await worker.callTool({ name: 'echo', arguments: { text: 'hi' } }); // first wire traffic
```

`getDiscoverResult()` is populated by the `'auto'`/pinned probe path, by `client.discover()`, and by a modern-verdict `connect({ prior })` (a legacy verdict leaves it `undefined`). The value round-trips through `JSON.stringify`/`JSON.parse`.

## What this story asserts

The server exposes a `request_count` tool returning how many MCP requests reached the process (`createMcpHandler` builds one server instance per request). The client asserts:

- after the bootstrap probe + one `request_count` call, the count is **2**;
- after three worker `connect({ prior })` calls + one `request_count` call, the count is **3** — proving the three connects sent **zero** requests;
- each worker can `callTool` immediately;
- after three `echo` calls + one `request_count` call, the count is **7**.

## When to use `prior`

- A gateway/proxy that holds a long-lived connection pool to one server and constructs a fresh `Client` per downstream request.
- A horizontally-scaled host where one worker's probe should seed the fleet (persist the blob to a shared cache).
- Reconnecting after a transient transport drop without re-probing.

## Security: same-credential reuse only

Only reuse a persisted `DiscoverResult` across workers that present the **same authorization context** as the bootstrap client (key the blob on a credential hash). Adopting a wider `prior` does not grant access — the server authorizes every request — but it can mislead
client-side capability gating.

The modern verdict — `prior: { kind: 'modern', discover }` wrapping a persisted `DiscoverResult` — is **modern-only**: no mutual 2026-07-28+ revision → `SdkError(EraNegotiationFailed)`. For a server known to be legacy, pass the negative verdict instead — `prior: { kind: 'legacy' }` skips the probe and goes straight to `initialize`. Freshness is the host's responsibility: date cached legacy verdicts in your own storage and stop supplying them past your policy horizon (a stale one succeeds silently against an upgraded server; with no `prior`, a `mode: 'auto'` client re-probes).
