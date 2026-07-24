---
'@modelcontextprotocol/sdk': patch
---

Hardens the Streamable HTTP server transport's SSE lifecycle: deferred work cannot register streams after transport close, error cleanup preserves successor request mappings, invalid timer delays safely disable keep-alive, and SSE responses disable proxy buffering.
