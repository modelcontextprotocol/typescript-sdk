# sse-polling

SEP-1699 server-initiated SSE disconnection + client reconnection with `Last-Event-ID` replay. **Sessionful 2025** by definition (the feature lives on `NodeStreamableHTTPServerTransport` + an `EventStore`). `eventStore` resumability is a 2025-session concern with no 2026-07-28
per-request equivalent — this is the only story that configures one.

Excluded from the harness for now (the reconnect/replay flow needs a longer, bounded wait than the per-leg default).

```bash
pnpm tsx examples/sse-polling/server.ts    # term 1 (port 3001)
pnpm tsx examples/sse-polling/client.ts    # term 2
```
