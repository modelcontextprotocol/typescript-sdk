---
'@modelcontextprotocol/server': minor
---

New subpath `@modelcontextprotocol/server/ext/tasks`: the server side of the MCP Tasks extension (`io.modelcontextprotocol/tasks`) as a server extension. `new TasksExtension(store)` in `ServerOptions.extensions` advertises the capability, serves `tasks/get`, `tasks/update` and `tasks/cancel`, gates task handles on the client capability (`-32021`), and offers `tasks.create(ctx)` for a tool handler to answer with a task handle. `TaskStore` (create / get / update / cancel over JSON) is the seam a server implements over its own state and execution; `InMemoryTaskStore` is the in-process reference with a writer `handle` for reporting status, requesting input, and settling. Wire types and zod schemas for the extension's 2026-07-28 schema are exported.
