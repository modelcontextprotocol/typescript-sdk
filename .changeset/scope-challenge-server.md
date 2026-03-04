---
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/node': minor
---

Add server-side OAuth scope challenge support (step-up auth) per MCP spec §10.1.

Servers can now declare required OAuth scopes per tool and the Streamable HTTP transport
automatically returns HTTP 403 with `WWW-Authenticate` headers when a client's token
lacks sufficient scopes, triggering the client's existing re-authorization flow.

New APIs:
- `ToolScopeConfig` type for declaring `required` and `accepted` scopes per tool
- `ScopeChallengeConfig` transport option with `resourceMetadataUrl`
- `McpServer.registerTool()` accepts a `scopes` option (`string[]` or `ToolScopeConfig`)
- `McpServer.setToolScopes()` for decoupled/centralized scope declaration
- `McpServer.getToolScopes()` to query resolved scope config
- `setScopeResolver()` on both `WebStandardStreamableHTTPServerTransport` and `NodeStreamableHTTPServerTransport`
- Auto-wiring of scope resolver in `McpServer.connect()`
