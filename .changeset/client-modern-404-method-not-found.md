---
'@modelcontextprotocol/client': patch
---

`StreamableHTTPClientTransport`: on a 2026-07-28 connection, an HTTP `404` whose body is a JSON-RPC `-32601` error (the server does not implement the method) now rejects the request with `ProtocolError(-32601)` instead of `SdkHttpError(404)`, as a `400` with a JSON-RPC error body already did. 2025-era connections are unchanged.
