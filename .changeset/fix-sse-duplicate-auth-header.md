---
'@modelcontextprotocol/client': patch
---

Fix SSEClientTransport duplicate Authorization header when both `requestInit.headers` and `eventSourceInit.fetch` set it. The SDK's internal SSE fetch wrapper now uses `opts.fetch` (or global `fetch`) as the underlying transport instead of `eventSourceInit.fetch`, preventing header duplication caused by the user's fetch iterating the SDK-supplied `Headers` instance into a plain object and re-adding the same key with different casing.
