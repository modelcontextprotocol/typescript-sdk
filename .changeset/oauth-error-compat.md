---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/client': patch
---

Restore OAuth error backwards compatibility with SDK 1.x: the per-code error subclasses (`InvalidGrantError`, `ServerError`, …) are exported again as deprecated wrappers around `OAuthError`, and SDK-produced OAuth errors are constructed as the matching subclass so 1.x-style
`instanceof` classification keeps working. Adds `oauthErrorFromCode()`, `isTransientOAuthError()` (which treats unknown error codes as transient, matching 1.x retry semantics), a deprecated `errorCode` alias for `code`, and the deprecated `OAUTH_ERRORS` map. The OAuth
`InvalidRequestError` returns as `OAuthInvalidRequestError` (the original name is taken by a JSON-RPC protocol type).
