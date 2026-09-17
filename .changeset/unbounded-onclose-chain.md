---
'@modelcontextprotocol/core-internal': patch
---

Fix an unbounded `onclose` handler chain in `Protocol.connect()`.

Each call to `connect()` on the same transport wrapped the existing
`transport.onclose` in a new closure that called the previous handler plus
`this._onclose()`. On transports that reconnect in-place (e.g. session-resuming
Streamable HTTP, or any caller that re-invokes `connect()` on the same transport
instance), the chain grew by one closure per reconnect. Every transport close
then walked the entire accumulated chain — a linear-memory leak proportional to
the number of reconnects.

`connect()` now detects that the transport is the same as the previously
connected one and skips re-wrapping `onclose`/`onerror`/`onmessage`, so the
existing wrapper (which already chains the prior handlers and calls
`this._onclose()`) is reused instead of nested again.
