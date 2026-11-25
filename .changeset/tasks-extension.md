---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

The MCP Tasks extension (`io.modelcontextprotocol/tasks`) as a pair of extensions. The `ext/tasks` subpaths of server, client and core are experimental: they may change in a minor release while the extensions SEPs settle.

`@modelcontextprotocol/server/ext/tasks`: `new TasksExtension(store)` in `McpServerOptions.extensions` advertises the capability, serves `tasks/get`, `tasks/update` and `tasks/cancel`, gates task handles on the client capability (`-32021`), binds each task to the creating request's principal (`principal` option; by default the OAuth client id plus the token subject), serves its methods on 2026-07-28 only (`-32601` on 2025-11-25), and offers `tasks.create(ctx)` for a tool handler to answer with a task handle. `TaskStore` (create / get / update / cancel over JSON) is the interface a server implements over its own state and execution; `InMemoryTaskStore` is the in-process reference with a writer `handle` for reporting status, requesting input, and settling. It refuses an input request that needs a client capability the creating request did not declare, and answers `-32602` to a `tasks/update` answer that is not a valid result for the request it answers. Task access is by principal only: a tool's `scopeChallenge` is not re-run on `tasks/*`.

`@modelcontextprotocol/client/ext/tasks`: `new TasksClientExtension()` in `ClientOptions.extensions` declares the capability on every request, accepts task handles on `tools/call`, and wraps the extension's methods: `callTool` (a task handle or the plain result, with `client.callTool`'s `Mcp-Param-*` header mirroring; `outputSchema` is checked on a plain result and on the final result of a task the extension started), `get`, `update`, `cancel`, and `waitFor`, which polls at the server's suggested interval to a terminal snapshot.

`@modelcontextprotocol/core/ext/tasks`: the extension's wire constants (`TASKS_EXTENSION_ID`, `TASK_STATUSES`), zod schemas and the types inferred from them, runtime-neutral. The server and client subpaths re-export the types and constants, plus the SDK's precise `InputRequest(s)` / `InputResponse(s)` types that `requireInput` and `update` take.

`McpServer` no longer validates a tool result of another kind, such as a task handle, against the tool's `outputSchema`: like an `input_required` result, it is not the tool's final output.
