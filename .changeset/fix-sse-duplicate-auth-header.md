---
'@modelcontextprotocol/client': patch
---

Fix duplicate Authorization header when using both `requestInit.headers` and `eventSourceInit.fetch`. The SDK's internal SSE fetch wrapper no longer delegates to `eventSourceInit.fetch`, preventing case-mismatch header duplication that caused `Bearer X, Bearer X` values and 401 rejections from strict servers.
