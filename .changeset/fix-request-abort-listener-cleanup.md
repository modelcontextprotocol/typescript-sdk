---
'@modelcontextprotocol/sdk': patch
---

`Protocol.request()` now removes its `abort` listener once the response arrives, and `cancel()` no longer acts after the request has settled. Aborting a controller after its request completed no longer sends a `notifications/cancelled` for the already-answered request, and the
resolved request no longer keeps a listener attached to the caller's `AbortSignal`.
