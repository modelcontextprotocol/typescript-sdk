---
'@modelcontextprotocol/server': patch
---

Handle EPIPE errors gracefully in stdio transport to prevent crashes when the connected process terminates unexpectedly.
