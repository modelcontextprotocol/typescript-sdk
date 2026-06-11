---
"@modelcontextprotocol/codemod": patch
---

The v1→v2 codemod's handler-registration transform now recognizes the task spec methods (`tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel`, and the `notifications/tasks/status` notification). `setRequestHandler`/`setNotificationHandler` calls passing a task schema are rewritten to the v2 method-string form instead of falling through to a manual-migration diagnostic.
