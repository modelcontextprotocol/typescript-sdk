---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

`ReadBuffer` now releases its backing allocation once the last buffered message is consumed, instead of retaining it through an empty `Buffer` view. Long-lived stdio transports no longer pin consumed chunks (pooled or multi-message buffers) until the next append, and the append after a full drain assigns the incoming chunk directly instead of copying through `Buffer.concat`. Fixes #2536
