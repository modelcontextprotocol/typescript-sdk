---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/server-legacy': patch
---

`OAuthTokensSchema` now treats null-valued optional members in OAuth token
responses as absent. Some authorization servers serialize absent optional
members as JSON `null` (not sanctioned by RFC 6749, but common in the wild);
previously `refresh_token`, `scope`, or `id_token` set to `null` failed
validation during token exchange and refresh, and `expires_in: null` silently
coerced to `0`, yielding an instantly-expired token. Nulls are now normalized
to `undefined` before validation; parsed output types are unchanged.
