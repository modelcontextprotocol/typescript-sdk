---
'@modelcontextprotocol/sdk': patch
---

InMemoryTaskStore now scopes task lookups to the session that created the task. The TaskStore interface has always passed a sessionId to every method; the in-memory reference store now records it at creation time and resolves task ids within that scope — lookups from a different session get the same not-found semantics as an unknown task id, and listTasks paginates within the caller's session. Tasks created without a session id (stdio, stateless HTTP, direct store access) keep their shared-namespace behavior, now documented on the class, and createTask warns once per store instance when session-scoped and sessionless tasks are mixed (usually a sign of a session id not being threaded through). The tasks/result handler resolves task visibility before draining the task's message queue.
