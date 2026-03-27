---
'@modelcontextprotocol/core': patch
---

Fix abort signal listener leak in outbound requests. When a caller reuses a single `AbortSignal` across multiple requests (common for session-scoped cancellation), the SDK previously attached a new listener per request without ever removing it. The listener is now detached when the request settles.
