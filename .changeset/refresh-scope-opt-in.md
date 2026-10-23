---
'@modelcontextprotocol/client': minor
---

Add an opt-in for sending `scope` on refresh-token requests, for authorization servers that reject a refresh without it (Microsoft Entra ID answers `AADSTS90009` when the client and the resource are the same app registration, #2718). `OAuthClientProvider` gains an optional `scopeForRefresh(tokens)`: `auth()`, and so the transports and `withOAuth`, sends the string it returns. `refreshAuthorization()` gains an optional `scope`. When a scope is sent and the response has none, the sent scope is kept on the returned tokens. Without either option the refresh request and the saved tokens are unchanged.
