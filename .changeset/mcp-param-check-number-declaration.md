---
'@modelcontextprotocol/server': patch
---

A server whose tool puts `x-mcp-header` on a `number`-typed parameter still serves that tool and keeps checking its `Mcp-Param-*` headers on `tools/call` as before: a header that is missing for a value in the body, or that disagrees with the body, is answered `400` with JSON-RPC error `-32020`. The server logs a warning for such a tool each time tools are listed, because clients on a 2026-07-28 HTTP connection no longer list it. Use an integer (`z.int()`) or remove the annotation.
