---
"@modelcontextprotocol/core-internal": minor
"@modelcontextprotocol/client": minor
---

Add `SdkHttpError` subclass with typed `.status` / `.statusText` accessors for HTTP transport failures. `StreamableHTTPClientTransport` now throws `SdkHttpError` (which extends `SdkError`) for non-OK HTTP responses; `SSEClientTransport` throws `SdkHttpError` for 401-after-reauth (circuit breaker).
