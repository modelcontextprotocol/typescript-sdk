---
'@modelcontextprotocol/server': minor
---

A low-level `Server` can now take part in the HTTP pre-dispatch checks that were only applied to `McpServer`: `setToolInputSchemaResolver(resolver)` gives `createMcpHandler` the tool input schemas for SEP-2243 `Mcp-Param-*` header validation, and `setScopeChallengeHandler(handler)` answers OAuth scope challenges in `createMcpHandler` and the Streamable HTTP transport. `McpServer` sets both on its own `Server`, so its behavior is unchanged. Without them a low-level `Server` is served as before, and a resolver set directly on a Streamable HTTP transport with `setScopeChallengeResolver` stays in effect; once `setScopeChallengeHandler` is called, the server's handler takes its place.
