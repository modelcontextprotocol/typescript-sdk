---
'@modelcontextprotocol/client': minor
---

Add `discoverOAuthServerInfo()` function and optional provider caching for authorization server discovery

- New `discoverOAuthServerInfo(serverUrl)` export that performs RFC 9728 protected resource metadata discovery followed by authorization server metadata discovery in a single call. Use this for operations like token refresh and revocation that need the authorization server URL outside of `auth()`.
- New optional `OAuthClientProvider` methods `saveAuthorizationServerUrl()` and `authorizationServerUrl()` allow providers to persist the discovered authorization server URL across sessions. When `authorizationServerUrl()` returns a cached URL, `auth()` skips RFC 9728 discovery, reducing latency on subsequent calls.
- New `OAuthServerInfo` type exported for the return value of `discoverOAuthServerInfo()`.
