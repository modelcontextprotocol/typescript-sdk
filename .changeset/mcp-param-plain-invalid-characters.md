---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/server': patch
---

A server on a 2026-07-28 connection now rejects an `Mcp-Param-*` or `Mcp-Name` header whose plain (not Base64-wrapped) value holds a character outside visible ASCII, space and tab, with `400` and JSON-RPC error `-32020`, as the spec's "Servers MUST reject requests with a recognized `Mcp-Param-{Name}` header that contains invalid characters" requires. Such a value was accepted when it equalled the body; conforming clients, this SDK's included, already send it as `=?base64?…?=`. The error message names which fault it is: a plain value that needed Base64 wrapping, or a broken sentinel.
