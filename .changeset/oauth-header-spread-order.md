---
'@modelcontextprotocol/client': patch
---

`StreamableHTTPClientTransport` and `SSEClientTransport` now give their transport-managed headers precedence over same-named entries in `requestInit.headers`: `Authorization` when `authProvider` yields a token, `mcp-protocol-version`, and (Streamable HTTP) `mcp-session-id`. Header names compare case-insensitively and every `HeadersInit` form is covered (plain object, tuple array, `Headers` instance). Previously the caller-supplied value won, so a static `Authorization` placeholder (e.g. an env-var API key) kept overriding the OAuth token even after the provider obtained one and the fallback-to-OAuth flow never completed; a `Headers` instance or lowercase key produced a combined `Bearer <fresh>, Bearer <stale>` value instead. A configured `Authorization` is still sent while the provider has no token, and other configured headers pass through unchanged. Closes #2208.
