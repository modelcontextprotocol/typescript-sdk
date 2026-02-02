---
"@modelcontextprotocol/server": patch
---

fix: prevent task-augmented tool errors from being masked

Re-throw McpErrors for task-augmented requests instead of wrapping them
in createToolError(). This prevents protocol errors from being masked
by "Invalid task creation result" errors during CreateTaskResultSchema validation.

Fixes #1385
