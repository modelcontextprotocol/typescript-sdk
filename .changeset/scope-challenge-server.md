---
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/node': minor
---

Add server-side OAuth scope challenge support (step-up auth) per MCP spec §10.1
and [SEP-2350](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2350).

Servers can now declare required OAuth scopes per tool and the Streamable HTTP transport
automatically returns HTTP 403 with `WWW-Authenticate` headers when a client's token
lacks sufficient scopes, triggering the client's existing re-authorization flow.

Per RFC 6750 §3.1 / SEP-2350, the `WWW-Authenticate` `scope` parameter advertises
only the scopes required for the current operation — clients are expected to
accumulate scopes across step-up challenges (see #1657). An opt-in
`scopeChallenge.includeGrantedScopes: true` restores the additive union behavior
for servers that need to defend against non-accumulating clients.

New APIs:
- `ToolScopeConfig` type for declaring `required` (AND) and `accepted` (OR / hierarchy) scopes per tool
- `ScopeChallengeConfig` transport option with `resourceMetadataUrl` and optional `includeGrantedScopes`
- `McpServer.registerTool()` accepts a `scopes` option (`string[]` or `ToolScopeConfig`)
- `McpServer.setToolScopes()` for decoupled/centralized scope declaration
- `McpServer.getToolScopes()` to query resolved scope config
- `setScopeResolver()` on both `WebStandardStreamableHTTPServerTransport` and `NodeStreamableHTTPServerTransport`
- Auto-wiring of scope resolver in `McpServer.connect()`
