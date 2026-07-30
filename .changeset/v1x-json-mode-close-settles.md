---
'@modelcontextprotocol/sdk': patch
---

Settle in-flight JSON-mode requests when the transport closes. `close()` runs every stream mapping's `cleanup`, but JSON response mode's `cleanup` only deleted the map entry — the `Promise<Response>` returned by `handleRequest()` was never settled, so a POST whose handler was still running hung until the client timed out. It now resolves with a `503` JSON-RPC error. The success path is unchanged: `send()` resolves before calling `cleanup()`, and re-resolving a settled promise is a no-op.
