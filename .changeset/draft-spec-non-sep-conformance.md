---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/client': patch
---

Non-SEP draft spec conformance fixes

- `McpServer` now eagerly installs list/read/call handlers for every primitive capability (`tools`, `resources`, `prompts`) declared in `ServerOptions.capabilities`. Per the draft spec, a server that declares a capability MUST respond to its list method (potentially with an empty result) instead of returning "Method not found". Previously, handlers were only installed lazily on first registration, so a server constructed with e.g. `capabilities: { tools: {} }` and zero registered tools answered `tools/list` with `-32601`. Low-level `Server` users remain responsible for registering handlers for declared capabilities (documented on `ServerOptions.capabilities`).
- Fixed pagination doc examples on `Client.listTools`/`listPrompts`/`listResources` to loop `while (cursor !== undefined)` instead of `while (cursor)` — per the draft spec, clients MUST NOT treat an empty-string cursor as the end of results.
