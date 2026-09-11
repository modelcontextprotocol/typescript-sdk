---
'@modelcontextprotocol/server': minor
---

New subpath `@modelcontextprotocol/server/ext/tasks`: the server side of the MCP Tasks extension (`io.modelcontextprotocol/tasks`) with a pluggable execution engine. `installTasks(server, { engine })` serves `tasks/get`, `tasks/update` and `tasks/cancel` and returns `registerTask`, which is `registerTool` for long-running work: the handler runs as a replayable workflow against a `Step` API (`do`, `sleep`, `sleepUntil`, `elicit`, `offer`, `checkInput`, `status`). Engines implement two interfaces — `TaskEngine` (create / get / update / cancel) and `StepJournal` (what the step API drives) — and `InMemoryTaskEngine` is the in-process reference. Durable engines live outside the SDK.
