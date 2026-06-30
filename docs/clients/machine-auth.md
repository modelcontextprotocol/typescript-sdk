---
status: scaffold
shape: how-to
---
# Authenticate without a user

<!-- ROUTER (one line, first body line of the page — proposal §3 path 4):
"Protecting a server you run → serving/authorization. Authenticating a user → clients/oauth.
No user (service-to-service) → this page." -->

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Client credentials, private-key JWT, cross-app access.
teaches: AuthProvider, ClientCredentialsProvider, PrivateKeyJwtProvider, CrossAppAccessProvider, discoverAndRequestJwtAuthGrant, exchangeJwtAuthGrant
source: mined from docs/client.md "Bearer tokens", "Client credentials", "Private key JWT", "Cross-App Access (Enterprise Managed Authorization)"
-->

## Authenticate with client credentials

<!-- teaches: ClientCredentialsProvider; the authProvider option is the same one OAuth uses | salvage: docs/client.md "Client credentials" -->

```ts
// draft - API verified against packages/client/src/client/authExtensions.ts (ClientCredentialsProvider implements OAuthClientProvider) and packages/client/src/client/streamableHttp.ts (authProvider)
import { Client, ClientCredentialsProvider, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const authProvider = new ClientCredentialsProvider({
  clientId: 'my-service',
  clientSecret: 'my-secret',
});

const client = new Client({ name: 'my-service', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL('https://api.example.com/mcp'), { authProvider });

await client.connect(transport);
```

<!-- result: the provider discovers the authorization server, runs the client_credentials grant, and refreshes the token on 401 — no browser, no user. -->

## Bring your own bearer token

<!-- teaches: the minimal AuthProvider interface (token(), optional onUnauthorized()) for tokens managed outside the SDK | salvage: docs/client.md "Bearer tokens" -->
<!-- code: const authProvider: AuthProvider = { token: async () => getStoredToken() } -->

## Sign with a private key instead of a secret

<!-- teaches: PrivateKeyJwtProvider (private_key_jwt token-endpoint auth) | salvage: docs/client.md "Private key JWT" -->
<!-- code: new PrivateKeyJwtProvider({ clientId, privateKey, algorithm: 'RS256' }) -->

## Act for an enterprise user with cross-app access

<!-- teaches: CrossAppAccessProvider (SEP-990), discoverAndRequestJwtAuthGrant; the IdP-token -> JAG -> access-token chain | salvage: docs/client.md "Cross-App Access (Enterprise Managed Authorization)" -->
<!-- code: new CrossAppAccessProvider({ assertion: async ctx => (await discoverAndRequestJwtAuthGrant({...})).jwtAuthGrant, clientId, clientSecret }) -->

## Drop to the token-exchange utilities

<!-- teaches: requestJwtAuthorizationGrant, discoverAndRequestJwtAuthGrant, exchangeJwtAuthGrant as standalone functions | salvage: docs/client.md "Cross-App Access" (Layer 2 list) -->
<!-- code: none — link the API reference for the three functions -->

## Recap

<!-- the claims this page will prove:
- Every flow on this page plugs in through the same authProvider transport option.
- ClientCredentialsProvider covers plain service-to-service; PrivateKeyJwtProvider replaces the shared secret with a signed assertion.
- A bare AuthProvider with only token() is enough when something else owns the token.
- CrossAppAccessProvider chains the enterprise IdP token through a JAG to an MCP access token (SEP-990).
- User-facing flows belong on clients/oauth.
-->
