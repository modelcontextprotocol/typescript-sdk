---
'@modelcontextprotocol/client': minor
---

Add `discoverOAuthServerInfo()` function and unified discovery state caching for OAuth

- New `discoverOAuthServerInfo(serverUrl)` export that performs RFC 9728 protected resource metadata discovery followed by authorization server metadata discovery in a single call. Use this for operations like token refresh and revocation that need the authorization server URL outside of `auth()`.
- New `OAuthDiscoveryState` type and optional `OAuthClientProvider` methods `saveDiscoveryState()` / `discoveryState()` allow providers to persist all discovery results (auth server URL, resource metadata URL, resource metadata, auth server metadata) across sessions. This avoids redundant discovery requests and handles browser redirect scenarios where discovery state would otherwise be lost.
- New `'discovery'` scope for `invalidateCredentials()` to clear cached discovery state.
- New `OAuthServerInfo` type exported for the return value of `discoverOAuthServerInfo()`.
