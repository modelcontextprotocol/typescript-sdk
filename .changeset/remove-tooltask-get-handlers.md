---
"@modelcontextprotocol/core": minor
"@modelcontextprotocol/server": minor
---

Make `ToolTaskHandler.getTask`/`getTaskResult` optional and actually invoke them

**Bug fix:** `getTask` and `getTaskResult` handlers registered via `registerToolTask` were never invoked — `tasks/get` and `tasks/result` requests always hit `TaskStore` directly.

**Breaking changes (experimental API):**

- `getTask` and `getTaskResult` are now **optional** on `ToolTaskHandler`. When omitted, `TaskStore` handles the requests (previous de-facto behavior).
- `TaskRequestHandler` signature changed: handlers receive only `(ctx: TaskServerContext)`, not the tool's input arguments.

**Migration:** If your handlers just delegated to `ctx.task.store`, delete them. If you're proxying an external job system (Step Functions, CI/CD pipelines), keep them and drop the `args` parameter.
