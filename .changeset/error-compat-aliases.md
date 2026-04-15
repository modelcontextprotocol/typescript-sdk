---
'@modelcontextprotocol/core': patch
---

Add v1-compat error aliases: `McpError`/`ErrorCode` (alias `ProtocolError`/`ProtocolErrorCode`, with `ConnectionClosed`/`RequestTimeout` from `SdkErrorCode`), `OAuthError.errorCode` getter (alias `.code`), `JSONRPCError`/`isJSONRPCError`, the 17 v1 OAuth error subclasses (`InvalidTokenError`, `ServerError`, …) as thin wrappers around `OAuthError` + `OAuthErrorCode`, and `StreamableHTTPError` (construct-only `@deprecated` shim; v2 throws `SdkError`).
