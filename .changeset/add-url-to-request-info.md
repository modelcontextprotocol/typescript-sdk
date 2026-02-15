---
'@modelcontextprotocol/sdk': patch
---

Add `url` property to `RequestInfo` interface as a `URL` type, exposing the full request URL to server handlers. The URL is unified across all HTTP transports (SSE and Streamable HTTP) to always provide the complete URL including protocol, host, and path.
