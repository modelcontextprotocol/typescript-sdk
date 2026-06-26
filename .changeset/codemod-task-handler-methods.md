---
'@modelcontextprotocol/codemod': patch
---

Emit a dedicated action-required diagnostic for v1 task-handler registrations (`setRequestHandler(GetTaskRequestSchema, …)`, `setNotificationHandler(TaskStatusNotificationSchema, …)`, and the other `tasks/*` schemas). The experimental tasks feature was removed in v2 (SEP-2663) and the `tasks/*` method strings are excluded from the typed `RequestMethod` / `NotificationMethod` surface, so these registrations are **not** rewritten to method-string form — the codemod marks each site with an `@mcp-codemod-error` comment pointing at the migration guide's tasks-removed section instead.
