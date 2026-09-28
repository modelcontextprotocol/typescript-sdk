---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/core': patch
---

Constructing `ClientCredentialsProvider`, `PrivateKeyJwtProvider`, `StaticPrivateKeyJwtProvider` or `CrossAppAccessProvider` without `expectedIssuer` is deprecated: the constructor logs one `console.warn` and that call signature is marked `@deprecated`. Behaviour is otherwise unchanged. Pass the `issuer` of the authorization server the credentials were registered with.

`auth()` now throws `AuthorizationServerMismatchError` instead of registering again when stored client information is bound to a different authorization server and the provider implements `addClientAuthentication()`; the custom client authentication belongs to the stored registration and would otherwise still be presented after the new registration. Clear the stored client information (`invalidateCredentials('client')`) to move such a provider to another authorization server.

`fetchToken()` throws `AuthorizationServerMismatchError`, before preparing or sending anything, when the provider's client information is bound to a different authorization server than the one it is called with. The `AuthorizationServerMismatchError` message no longer assumes the authorization-code callback; its fields are unchanged.

`OAuthTokensSchema` and `OAuthClientInformationSchema` accept the optional `issuer` stamp, so a provider that reads storage back through them keeps it. `auth()` overwrites it on every save.
