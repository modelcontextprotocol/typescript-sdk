---
'@modelcontextprotocol/client': patch
---

On the 2026-07-28 protocol, a request for a method the server does not implement now rejects with a `ProtocolError` carrying code `-32601` (Method not found), matched to the request. The spec has servers answer this with HTTP 404 and a JSON-RPC error body; the client used to reject with an `SdkHttpError` (`CLIENT_HTTP_NOT_IMPLEMENTED`, status 404) and report the same error to `onerror`. A 404 without a JSON-RPC error body, and every 404 on 2025-era requests, still rejects with `SdkHttpError`.
