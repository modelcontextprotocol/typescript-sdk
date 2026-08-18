---
'@modelcontextprotocol/server': minor
---

Add a `maxRequestBodySize` option to the streamable HTTP server transport (default 4 MiB) and reject oversized POST bodies with 413 Payload Too Large, matching the other official SDKs.
