---
'@modelcontextprotocol/sdk': patch
---

Close a Streamable HTTP request stream after Last-Event-ID replay when no in-flight request still maps to it, so resume polling converges instead of holding keep-alive open and blocking a later reconnect with 409.
