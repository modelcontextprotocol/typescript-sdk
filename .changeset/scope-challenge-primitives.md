---
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/node': minor
---

Extend OAuth scope challenge support to non-tool primitives.

Building on the tool-side implementation, `resources/read`, `prompts/get`, and
`completion/complete` now participate in the same pre-execution scope check.

- `registerResource()` accepts `scopes` in its config, supporting static
  arrays, `ToolScopeConfig`, or a dynamic resolver `(uri, variables) => scopes`
  for templated resources where the required scope depends on path parameters.
- `registerPrompt()` accepts `scopes` in its config.
- `setResourceScopes()`, `setPromptScopes()`, and `setCompletionScopes()` allow
  decoupled or centralised scope declaration.
- Completion scopes are an explicit, separate domain with no inheritance from
  the referenced prompt or resource; pass `'*'` as `argumentName` to apply the
  same scopes to every argument of a reference.

Internally, the transport's `ScopeResolver` is now operation-aware. It
receives the full JSON-RPC request and returns a `ScopeResolution` object
carrying both the scope config and an `operationName` label
(`tool:foo`, `resource:foo://bar`, `prompt:foo`, `completion:...`).
`McpServer.connect()` auto-wires a router that dispatches on JSON-RPC method.
