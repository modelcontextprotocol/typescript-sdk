---
shape: how-to
description: 'Authenticate a client with no user present: client credentials, private-key JWT, and cross-app access.'
---
# Authenticate without a user

Protecting a server you run → [Require authorization](../serving/authorization.md). Authenticating an end user → [OAuth](./oauth.md). No user — a job, a backend, a service account → this page.

## Authenticate with client credentials

`ClientCredentialsProvider` runs the OAuth `client_credentials` grant from a `client_id` and `client_secret`. Pass it as the transport's `authProvider` — every flow on this page plugs into that same option.

```ts source="../../examples/guides/clients/machine-auth.examples.ts#clientCredentials_connect"
import { Client, ClientCredentialsProvider, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const authProvider = new ClientCredentialsProvider({
    clientId: 'reporting-job',
    clientSecret: 'reporting-job-secret'
});

const client = new Client({ name: 'reporting-job', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL('https://api.example.com/mcp'), { authProvider });

await client.connect(transport);
```

`connect` discovers the server's authorization server, posts the grant to its token endpoint, and attaches the access token to every request. On a 401 the provider refreshes the token and the transport retries once. No browser, no end user.

::: tip
Pass `expectedIssuer` to pin the credential to the authorization server it was registered with. If discovery resolves a different issuer, the SDK throws `AuthorizationServerMismatchError` instead of sending the secret.
:::

## Bring your own bearer token

When something outside the SDK already owns the token — an API key, a gateway, a platform secret store — implement `AuthProvider` with only `token()`.

```ts source="../../examples/guides/clients/machine-auth.examples.ts#bearerToken_provider"
const authProvider: AuthProvider = { token: async () => getStoredToken() };

const transport = new StreamableHTTPClientTransport(new URL('https://api.example.com/mcp'), { authProvider });
```

The transport calls `token()` before every request and sets the `Authorization` header from whatever it returns. Without `onUnauthorized`, a 401 throws `UnauthorizedError`. Add `onUnauthorized(ctx)` to refresh the credential and the transport retries the request once.

## Sign with a private key instead of a secret

`PrivateKeyJwtProvider` runs the same `client_credentials` grant, but authenticates the token request with a signed JWT assertion (`private_key_jwt`, RFC 7523) in place of a shared secret.

```ts source="../../examples/guides/clients/machine-auth.examples.ts#privateKeyJwt_provider"
const authProvider = new PrivateKeyJwtProvider({
    clientId: 'reporting-job',
    privateKey: pemEncodedKey,
    algorithm: 'RS256'
});

const transport = new StreamableHTTPClientTransport(new URL('https://api.example.com/mcp'), { authProvider });
```

`privateKey` accepts a PEM string, a `Uint8Array`, or a JWK object. The provider signs a fresh assertion for every token request; `jwtLifetimeSeconds` overrides the 300-second default, and `claims` merges extra claims into the assertion.

## Act for an enterprise user with cross-app access

**Cross-app access** (Enterprise Managed Authorization, SEP-990) lets a service reach an MCP server for a user who already authenticated with the enterprise IdP, with no second consent screen. Two exchanges get it there: the IdP ID Token becomes a **JWT Authorization Grant** (RFC 8693), and that grant becomes an MCP access token (RFC 7523).

`CrossAppAccessProvider` runs the second exchange. Your `assertion` callback supplies the grant — here `discoverAndRequestJwtAuthGrant` performs the first exchange against the IdP.

```ts source="../../examples/guides/clients/machine-auth.examples.ts#crossAppAccess_provider"
const authProvider = new CrossAppAccessProvider({
    assertion: async ctx => {
        const grant = await discoverAndRequestJwtAuthGrant({
            idpUrl: 'https://idp.example.com',
            audience: ctx.authorizationServerUrl,
            resource: ctx.resourceUrl,
            idToken: await getIdToken(),
            clientId: 'idp-exchange-client',
            clientSecret: 'idp-exchange-secret',
            scope: ctx.scope,
            fetchFn: ctx.fetchFn
        });
        return grant.jwtAuthGrant;
    },
    clientId: 'reporting-job',
    clientSecret: 'reporting-job-secret'
});

const transport = new StreamableHTTPClientTransport(new URL('https://api.example.com/mcp'), { authProvider });
```

The SDK discovers the MCP server's authorization server and resource URL (RFC 9728) before it calls `assertion`, then hands them in on `ctx` together with the negotiated `scope` and the transport's `fetchFn`. Pass them through so the IdP issues a grant bound to the right audience and resource.

## Drop to the token-exchange utilities

Both exchanges behind `CrossAppAccessProvider` are exported as standalone functions for flows the provider does not cover — caching grants across transports, a non-standard IdP step, your own token store.

- `requestJwtAuthorizationGrant` exchanges an ID Token for a JWT Authorization Grant at a known IdP token endpoint (RFC 8693).
- `discoverAndRequestJwtAuthGrant` performs the same exchange, discovering the IdP's token endpoint from `idpUrl` first.
- `exchangeJwtAuthGrant` exchanges a JWT Authorization Grant for an access token at the MCP server's authorization server (RFC 7523).

All three live in [`client/crossAppAccess`](../api/@modelcontextprotocol/client/client/crossAppAccess.md) in the API reference.

## Recap

- Every flow on this page plugs in through the same `authProvider` option on `StreamableHTTPClientTransport`.
- `ClientCredentialsProvider` runs the `client_credentials` grant with a shared secret; `PrivateKeyJwtProvider` runs the same grant with a signed JWT assertion in its place.
- An `AuthProvider` with only `token()` is enough when something outside the SDK owns the token; without `onUnauthorized`, a 401 throws `UnauthorizedError`.
- `CrossAppAccessProvider` chains an enterprise IdP token through a JWT Authorization Grant to an MCP access token (SEP-990), and both exchanges are exported standalone.
- Authenticating an end user belongs on [OAuth](./oauth.md).
