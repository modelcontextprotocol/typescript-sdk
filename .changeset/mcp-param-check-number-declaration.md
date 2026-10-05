---
'@modelcontextprotocol/server': patch
---

A server whose tool puts `x-mcp-header` on a `number`-typed parameter keeps checking that tool's `Mcp-Param-*` headers on `tools/call`, as 2.3.0 does: a header that is missing for a value in the body, or that disagrees with the body, is answered `400` with JSON-RPC error `-32020`. Clients on a 2026-07-28 connection no longer list such a tool and send no `Mcp-Param-*` headers for it, so their calls to it are rejected the same way; the server logs a warning each time tools are listed. Use an integer (`z.int()`) or remove the annotation.
