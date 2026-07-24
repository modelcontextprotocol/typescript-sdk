---
'@modelcontextprotocol/sdk': patch
---

Hardens the Streamable HTTP server transport's SSE keep-alive lifecycle: timers can no longer be armed after transport close or leak when a priming event write fails, invalid timer delays safely disable keep-alive, and SSE responses disable nginx-style proxy buffering.
