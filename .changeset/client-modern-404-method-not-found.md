---
'@modelcontextprotocol/client': patch
---

`StreamableHTTPClientTransport`: on a 2026-07-28 connection, an HTTP `404` whose body is a JSON-RPC error response for the request (such as `-32601` for a method the server does not implement) now rejects the request with that error as a `ProtocolError` instead of `SdkHttpError(404)`, as a `400` with a JSON-RPC error body already did. 2025-era connections are unchanged.
