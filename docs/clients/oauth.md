---
status: scaffold
shape: how-to
---
# Authenticate a user with OAuth

<!-- ROUTER (one line, first body line of the page — Felix ruling, proposal §3 path 4):
"Protecting a server you run → serving/authorization. Authenticating a user → this page.
No user → clients/machine-auth." -->

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: User-facing authorization-code flow. Opens with the one-line auth router.
teaches: OAuthClientProvider, StreamableHTTPClientTransport authProvider option, UnauthorizedError, StreamableHTTPClientTransport.finishAuth, IssuerMismatchError, OAuthClientProvider.validateResourceURL
source: mined from docs/client.md "Full OAuth with user authorization", "Resource indicators (RFC 8707)"
-->

## Hand the transport an OAuth provider

<!-- teaches: authProvider option on StreamableHTTPClientTransport; connect() throws UnauthorizedError when authorization is needed | salvage: docs/client.md "Full OAuth with user authorization" -->

```ts
// draft - API verified against packages/client/src/client/streamableHttp.ts (authProvider option, finishAuth) and packages/client/src/client/auth.ts (OAuthClientProvider, UnauthorizedError)
const transport = new StreamableHTTPClientTransport(new URL('https://api.example.com/mcp'), {
  authProvider: provider, // your OAuthClientProvider
});

try {
  await client.connect(transport);
} catch (error) {
  if (!(error instanceof UnauthorizedError)) throw error;
  // The provider's redirectToAuthorization() already sent the end user to the browser.
}
```

<!-- result: on a 401 the SDK runs discovery, registers (or looks up) the client, and calls your provider's redirectToAuthorization(url). -->

## Implement OAuthClientProvider

<!-- teaches: the OAuthClientProvider interface — redirectUrl, clientMetadata, clientInformation/saveClientInformation keyed by ctx.issuer, tokens/saveTokens, state, codeVerifier, saveDiscoveryState | salvage: docs/client.md "Full OAuth with user authorization" (MyOAuthProvider block) -->
<!-- code: a minimal OAuthClientProvider class; keep the issuer-keyed credential map (SEP-2352) -->

## Finish the flow from the callback

<!-- teaches: transport.finishAuth(URLSearchParams), state comparison, reconnect on a FRESH transport | salvage: docs/client.md "Full OAuth with user authorization" (auth_finishAuth block) -->
<!-- code: compare state, await transport.finishAuth(params), then client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider })) -->

## Handle issuer mismatch

<!-- teaches: IssuerMismatchError (kind 'authorization_response' vs 'metadata'), never render error_description on mismatch | salvage: docs/client.md "Full OAuth with user authorization" (issuer-validation paragraph) -->
<!-- code: catch IssuerMismatchError around finishAuth -->
<!-- aside: ::: warning — security: a mix-up attacker controls error_description; do not show it. skipIssuerMetadataValidation exists but weakens this. -->

## Pin the resource indicator

<!-- teaches: OAuthClientProvider.validateResourceURL, checkResourceAllowed, resourceUrlFromServerUrl (RFC 8707) | salvage: docs/client.md "Resource indicators (RFC 8707)" -->
<!-- code: validateResourceURL override returning the URL to force, or undefined to omit -->

## Recap

<!-- the claims this page will prove:
- This page is for clients acting on behalf of a USER; machine-to-machine flows live on clients/machine-auth.
- Pass an OAuthClientProvider as the transport's authProvider; connect() throws UnauthorizedError when the end user must authorize.
- finishAuth(params) with the whole callback query lets the SDK validate iss (RFC 9207) and exchange the code.
- Always reconnect on a fresh transport; OAuth state lives on the provider.
- IssuerMismatchError is the mix-up defense; do not weaken it.
-->
