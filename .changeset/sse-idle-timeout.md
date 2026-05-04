---
'@modelcontextprotocol/client': minor
---

Add `idleTimeoutMs` option to `StreamableHTTPClientTransport`. When set, the SSE stream
reader cancels itself if no chunk arrives within the configured window, and the existing
disconnect/reconnect path runs (same as a network drop). The timer resets on every chunk,
so this is a per-chunk inactivity timeout, not a total stream lifetime.

Useful for half-open TCP connections, stalled servers, and proxies that go silent without
closing the socket — without it, `reader.read()` blocks indefinitely and the agent hangs.
Defaults to undefined (no timeout, same as today). Closes #1883.
