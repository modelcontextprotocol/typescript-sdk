---
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/node': minor
---

Add per-tool OAuth scope challenges. Tools can accept alternative named paths,
require all scopes in a path, accept exact alternatives for each scope, and
choose applicable paths from the request.

`createMcpHandler` and Streamable HTTP transports return HTTP 403 with an
`insufficient_scope` challenge before tool execution. A `string[]` requires
every listed scope.
