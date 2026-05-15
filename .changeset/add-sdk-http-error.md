---
"@modelcontextprotocol/core": minor
"@modelcontextprotocol/client": minor
---

Add `SdkHttpError` subclass with typed `.status` / `.statusText` accessors for HTTP transport failures. `StreamableHTTPClientTransport` and `SSEClientTransport` now throw `SdkHttpError` (which extends `SdkError`) for non-OK HTTP responses.
