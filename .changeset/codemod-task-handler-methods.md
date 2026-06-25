---
'@modelcontextprotocol/codemod': patch
---

Map the task request/notification schemas to their v2 method strings in the handler-registration transform. `setRequestHandler(GetTaskRequestSchema, …)`, `setNotificationHandler(TaskStatusNotificationSchema, …)`, and the other task handlers (`tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel`, `notifications/tasks/status`) now rewrite to the v2 two-argument method-string form instead of falling through to the generic "use the 3-argument form" manual-migration diagnostic.
