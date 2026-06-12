---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/core': patch
---

Resource not found now returns `-32602` (Invalid params) per SEP-2164; `-32002` (`ProtocolErrorCode.ResourceNotFound`) is deprecated. The error includes the requested URI in `data.uri` so clients can still distinguish not-found from other invalid-params errors. Clients SHOULD continue to accept legacy `-32002` from older servers.
