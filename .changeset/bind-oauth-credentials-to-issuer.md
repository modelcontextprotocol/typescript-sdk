---
'@modelcontextprotocol/sdk': patch
---

Bind stored OAuth client credentials to the authorization server that issued them. `auth()` adds an `issuer` property to what it passes to `saveClientInformation()` / `saveTokens()` and does not reuse a stored value with a different authorization server: the client registers or
authorizes again, or `auth()` throws when the credentials cannot be re-created by registering. `OAuthTokensSchema` and `OAuthClientInformationSchema` accept the optional `issuer`. `ClientCredentialsProvider`, `PrivateKeyJwtProvider` and `StaticPrivateKeyJwtProvider` accept
`expectedIssuer`; omitting it is deprecated.
