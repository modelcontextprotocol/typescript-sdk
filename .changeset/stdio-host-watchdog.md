---
'@modelcontextprotocol/server': minor
---

Add host process watchdog to StdioServerTransport. When `clientProcessId` is provided, the transport periodically checks if the host process is alive and self-terminates if it is gone, preventing orphaned server processes.
