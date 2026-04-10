---
'@modelcontextprotocol/server': patch
---

Close StdioServerTransport when stdin reaches EOF. When the host process exits or is killed, the stdin pipe closes and the transport now detects this via the `end` event, preventing orphaned server processes. Aligns with the behavior of the Python and Kotlin SDKs.
