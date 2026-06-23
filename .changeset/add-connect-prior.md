---
'@modelcontextprotocol/client': minor
---

Add `connect(transport, { prior: DiscoverResult })` for zero-round-trip reconnect (the gateway / distributed-client pattern). Supplying a previously-obtained `DiscoverResult` skips the `server/discover` probe: on a 2026-era server `connect()` sends nothing on the wire and `callTool()` etc. work immediately. Pair with the new `client.getDiscoverResult()` (populated by the `'auto'`-mode probe, by `client.discover()`, and by `connect({ prior })` itself) — the value round-trips through `JSON.stringify`, so a gateway can probe once, persist the blob, and feed it to every worker. Only reuse a persisted `DiscoverResult` across clients that present the same authorization context as the client that obtained it.
