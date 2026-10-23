---
'@modelcontextprotocol/sdk': patch
---

A tool registered with `registerToolTask` and `taskSupport: 'optional'` no longer hangs when it is called without task augmentation and its task sends a request with `relatedTask` (for example an elicitation). Such a client never calls `tasks/result`, so the queued request was
never delivered and the task stayed `input_required` until the call timed out. On these calls the request is now sent directly on the `tools/call` response stream; task-augmented calls are unchanged.
