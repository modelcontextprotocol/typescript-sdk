---
'@modelcontextprotocol/server': patch
---

Add a default `maxBodyBytes` limit for `WebStandardStreamableHTTPServerTransport` to prevent unbounded JSON request body buffering (413 on oversized payloads).

