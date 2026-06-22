---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/client': minor
---

Client request cancellation on a 2026-07-28 Streamable HTTP connection now closes that request's SSE response stream — the spec cancellation signal — instead of POSTing `notifications/cancelled`. Cancellation on a 2025-era connection, and on stdio at any era, still sends `notifications/cancelled` as before. Adds the optional `Transport.hasPerRequestStream` capability flag (set on `StreamableHTTPClientTransport`) for the protocol layer to route the per-transport cancel path.
