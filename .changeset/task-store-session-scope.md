---
'@modelcontextprotocol/sdk': patch
---

`InMemoryTaskStore` (experimental tasks) now keeps the `sessionId` a task was created with. A call that passes a different `sessionId` gets the same result as for an unknown task id, and `listTasks` with a `sessionId` returns the tasks of that session and the tasks created
without a `sessionId`. The built-in `tasks/get`, `tasks/result`, `tasks/list` and `tasks/cancel` handlers already pass the session of the request, and `tasks/result` now looks the task up before it delivers queued messages. Calls that pass no `sessionId`, such as server code that
holds the store, stdio servers and stateless HTTP servers, behave as before, and a task created without a `sessionId` is returned to any caller that has its id.

On a server with sessions that uses this store, a task is reachable from the session that created it and not from another one: in another session `tasks/list` does not include the task, and `tasks/get`, `tasks/result` and `tasks/cancel` answer that it was not found. A client that
comes back with a new session id does not see its earlier tasks; with `SSEServerTransport` (legacy SSE) every reconnect is a new session. Sessions that get the same id share their tasks, so a `sessionIdGenerator` must not return the same value twice.

Replies queued for a task follow the same lookup. On a connection with a session and a `taskMessageQueue`, a request that names a related task (`io.modelcontextprotocol/related-task` in `_meta`) is first looked up in the store for the session of the request. If the store does not
find the task, the request is answered that the task was not found (for a method without a handler: that the method was not found) and nothing is queued for that task. A request related to a task of its own session is handled as before, and so is every request on a connection
without a session. The session id of the connection is now passed on every call to the `TaskMessageQueue`; `InMemoryTaskMessageQueue` still keys its queues by task id.

Tasks stay shared, as before, in three configurations where callers are not told apart by session: a custom `TaskStore` that does not use the `sessionId` it receives, a server without sessions (Streamable HTTP with `sessionIdGenerator: undefined`), and one store shared by an
endpoint with sessions and an endpoint without, where requests without a session also reach the tasks of the sessions. A custom `TaskStore` shared by several sessions should treat the `sessionId` it receives the way `InMemoryTaskStore` now does.
