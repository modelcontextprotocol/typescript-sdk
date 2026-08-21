---
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/node': minor
---

Add request-time OAuth scope challenges for tools. A tool's `scopeChallenge`
callback receives the parsed request and verified authentication info, then
either continues or returns the exact scope set for an `insufficient_scope`
response. `requireScopes` provides a small helper for static all-of checks.

`createMcpHandler` and Streamable HTTP transports return HTTP 403 with an
`insufficient_scope` challenge before tool execution or SSE setup.
