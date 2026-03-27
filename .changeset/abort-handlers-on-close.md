---
'@modelcontextprotocol/core': patch
---

Abort in-flight request handlers when the connection closes. Previously, request handlers would continue running after the transport disconnected, wasting resources and preventing proper cleanup. Also fixes `InMemoryTransport.close()` firing `onclose` twice on the initiating side.
