---
'@modelcontextprotocol/sdk': patch
---

Make `Client.cacheToolMetadata()` failure-atomic so a schema compilation error during `listTools()` leaves the previous cached output validators and task metadata intact.
