---
'@modelcontextprotocol/sdk': patch
---

`InMemoryTaskStore` (experimental tasks) now keeps the `sessionId` a task was created with. A call that passes a different `sessionId` gets the same result as for an unknown task id, and `listTasks` with a `sessionId` returns only the tasks of that session. The built-in
`tasks/get`, `tasks/result`, `tasks/list` and `tasks/cancel` handlers already pass the session of the request, and `tasks/result` now looks the task up before it delivers queued messages. Calls that pass no `sessionId`, such as server code that holds the store, stdio servers and
stateless HTTP servers, behave as before, and a task created without a `sessionId` is returned to any caller that has its id.

On a server with sessions that uses this store, a task is reachable from the session that created it and not from another one: in another session `tasks/list` does not include the task, and `tasks/get`, `tasks/result` and `tasks/cancel` answer that it was not found. A client that
comes back with a new session id does not see its earlier tasks; with `SSEServerTransport` (legacy SSE) every reconnect is a new session. Sessions that get the same id share their tasks, so a `sessionIdGenerator` must not return the same value twice.

Tasks stay shared, as before, in three configurations where callers are not told apart by session: a custom `TaskStore` that does not use the `sessionId` it receives, a server without sessions (Streamable HTTP with `sessionIdGenerator: undefined`), and one store shared by an
endpoint with sessions and an endpoint without, where requests without a session also reach the tasks of the sessions. A custom `TaskStore` shared by several sessions should treat the `sessionId` it receives the way `InMemoryTaskStore` now does.
