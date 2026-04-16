---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

v1-compat: add `@deprecated` flat fields (`signal`, `requestId`, `_meta`, `authInfo`, `sendNotification`, `sendRequest`, `taskStore`, `taskId`, `taskRequestedTtl`) on the handler context (`ClientContext`/`ServerContext`) mirroring the nested `ctx.mcpReq` / `ctx.http` / `ctx.task` fields, plus the `RequestHandlerExtra` type alias. Covers the common v1 `extra.*` accesses; HTTP-transport-specific fields (`requestInfo`, `closeSSEStream`, `closeStandaloneSSEStream`) are not shimmed and require migration to `ctx.http?.req` / `ctx.http?.closeSSE`.
