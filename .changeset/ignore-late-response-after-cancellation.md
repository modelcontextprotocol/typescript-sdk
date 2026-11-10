---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

A response that arrives after its request was cancelled or timed out is now ignored, as the cancellation spec says the sender should. Previously it raised `onerror` with "Received a response for an unknown message ID". The request still rejects as before.
