---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/core': patch
---

Constructing `ClientCredentialsProvider`, `PrivateKeyJwtProvider`, `StaticPrivateKeyJwtProvider` or `CrossAppAccessProvider` without `expectedIssuer` is deprecated: the constructor logs one `console.warn` and that call signature is marked `@deprecated`. Behaviour is otherwise unchanged. Pass the `issuer` of the authorization server the credentials were registered with.

`fetchToken()` throws `AuthorizationServerMismatchError`, before preparing or sending anything, when the provider's client information is bound to a different authorization server than the one it is called with. The `AuthorizationServerMismatchError` message no longer assumes the authorization-code callback; its fields are unchanged.

`OAuthTokensSchema` and `OAuthClientInformationSchema` accept the optional `issuer` stamp, so a provider that reads storage back through them keeps it. `auth()` overwrites it on every save.
