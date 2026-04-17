---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Add v1-compat `@deprecated` error aliases: `McpError`/`ErrorCode` (alias `ProtocolError`/`ProtocolErrorCode`, with `ConnectionClosed`/`RequestTimeout` from `SdkErrorCode`), `OAuthError.errorCode` getter (alias `.code`), `JSONRPCError`/`isJSONRPCError`, 16 of the 17 v1 OAuth error subclasses (`InvalidTokenError`, `ServerError`, … — `InvalidRequestError` is omitted from the public surface to avoid colliding with the JSON-RPC `InvalidRequest` type) as thin wrappers around `OAuthError` + `OAuthErrorCode`, and `StreamableHTTPError` as an `SdkError` subclass that the StreamableHTTP client transport now throws (so `instanceof StreamableHTTPError` matches; `.status` carries the HTTP status code).
