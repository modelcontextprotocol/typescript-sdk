---
'@modelcontextprotocol/client': patch
---

Client `callTool` and `experimental.tasks.callToolStream` now skip `outputSchema` validation when a tool result has `isError: true`, matching server-side `validateToolOutput` behavior. Tools that return a structured error envelope (e.g. `{ error: { code, message } }`) are no longer rejected with `Structured content does not match the tool's output schema`. Fixes #1943.
