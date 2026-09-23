---
'@modelcontextprotocol/core-internal': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

The MCP Tasks extension (`io.modelcontextprotocol/tasks`) as a pair of extensions.

`@modelcontextprotocol/server/ext/tasks`: `new TasksExtension(store)` in `ServerOptions.extensions` advertises the capability, serves `tasks/get`, `tasks/update` and `tasks/cancel`, gates task handles on the client capability (`-32021`), and offers `tasks.create(ctx)` for a tool handler to answer with a task handle. `TaskStore` (create / get / update / cancel over JSON) is the interface a server implements over its own state and execution; `InMemoryTaskStore` is the in-process reference with a writer `handle` for reporting status, requesting input, and settling.

`@modelcontextprotocol/client/ext/tasks`: `new TasksClientExtension()` in `ClientOptions.extensions` declares the capability on every request, accepts task handles on `tools/call`, and wraps the extension's methods: `callTool` (a task handle or the plain result), `get`, `update`, `cancel`, and `waitFor`, which polls at the server's suggested interval to a terminal snapshot.

Wire types and zod schemas for the extension's 2026-07-28 schema live at `@modelcontextprotocol/core-internal/ext/tasks` and are re-exported from both subpaths.
