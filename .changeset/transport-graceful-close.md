---
'@modelcontextprotocol/client': patch
---

Stop propagating the transport-wide `AbortController` signal to outgoing POST and DELETE requests in `SSEClientTransport` and `StreamableHTTPClientTransport`. Previously, calling `close()` on a transport that had just completed a successful POST would still abort the underlying `fetch` controller, causing Undici-based instrumentation (e.g. OpenTelemetry) to report the successful request as aborted (`UND_ERR_ABORTED`). The transport's own signal is now used only for the SSE GET stream and reconnection-state gating; per-request cancellation can still be supplied by the user via `requestInit.signal`.
