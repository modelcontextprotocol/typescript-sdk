---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/server': patch
---

Pin the modern (2026-07-28) HTTP serving path's rejection codes to the assignments the published conformance suite asserts: a header/body cross-check mismatch (`MCP-Protocol-Version` or `Mcp-Method` disagreeing with the request body) is now rejected with `-32001` (HeaderMismatch), and a request whose protocol-version header names a modern revision but whose body is missing the `_meta` envelope (or its required protocol-version key) is rejected with `-32602` invalid params naming the missing key(s). Both keep HTTP 400. These cells previously emitted a provisional `-32004` while the upstream error-code discussion was open. The envelope-less rejection on a modern-only endpoint (`-32004` with the supported-versions list), the 2025-era serving paths, and the client-side probe handling are unchanged.
