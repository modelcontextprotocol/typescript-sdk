---
'@modelcontextprotocol/server': patch
---

Reject a request on a `serveStdio` connection pinned to the 2026-07-28 revision when that request's `_meta` envelope names a protocol version the server does not implement. The response is `-32022` with the supported list, and the method does not run. An unknown method is still `-32601`, and a missing or malformed envelope is still `-32602`.
