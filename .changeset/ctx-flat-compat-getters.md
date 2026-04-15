---
'@modelcontextprotocol/core': patch
---

v1-compat: add flat fields (`signal`, `requestId`, `_meta`, `authInfo`, `sendNotification`, `sendRequest`, `taskStore`, `taskId`, `taskRequestedTtl`) on the handler context (`ClientContext`/`ServerContext`) mirroring the nested `ctx.mcpReq` / `ctx.http` / `ctx.task` fields, plus the `RequestHandlerExtra` type alias. Allows v1 handler signatures to compile and run unchanged.
