---
"@modelcontextprotocol/core-internal": patch
"@modelcontextprotocol/server": patch
---

Reject duplicate in-flight request ids in the streamable HTTP server transport instead of cross-wiring responses, retire transport bookkeeping for cancelled requests so their ids stay reusable, and add the missing `isCancelledNotification` guard to core-internal.
