---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/node': patch
---

Resource not found now returns `-32602` (Invalid params) per SEP-2164; `-32002` (`ProtocolErrorCode.ResourceNotFound`) is deprecated. The error includes the requested URI in `data.uri` so clients can still distinguish not-found from other invalid-params errors. Clients SHOULD
continue to accept legacy `-32002` from older servers.

This supersedes the earlier 2.0.0-alpha.1 / #1389 resource error-code change that moved unknown resource reads to `-32002`.

`NodeStreamableHTTPServerTransport` now forwards server-configured supported protocol versions to the underlying web-standard transport, so custom version lists passed to `McpServer` are also honored by HTTP header validation.
