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

## Authenticate with a workload identity

**Workload Identity Federation** (WIF, SEP-1933, extension id `io.modelcontextprotocol/auth/wif`) lets a workload that already holds a platform-issued JWT exchange that JWT directly for an MCP access token: a Kubernetes projected service account token, a SPIFFE JWT-SVID, a cloud identity token. No client secret is provisioned anywhere and no dynamic client registration happens; the workload's existing platform identity is the credential.

`WorkloadIdentityProvider` runs the RFC 7523 `jwt-bearer` grant (`urn:ietf:params:oauth:grant-type:jwt-bearer`) with the workload JWT as the `assertion`, the same grant `CrossAppAccessProvider` uses, but presenting the workload's own JWT instead of a JWT Authorization Grant exchanged from an IdP.

```ts source="../../examples/guides/clients/machine-auth.examples.ts#workloadIdentity_provider"
function fileAssertionSource(tokenPath: string): WorkloadAssertionCallback {
    return async () => (await readWorkloadToken(tokenPath)).trim();
}

const authProvider = new WorkloadIdentityProvider({
    clientId: 'reporting-job',
    assertion: fileAssertionSource('/var/run/secrets/workload/token')
});

const transport = new StreamableHTTPClientTransport(new URL('https://api.example.com/mcp'), { authProvider });
```

`clientId` is required by this SDK's auth flow, which operates on stored client information; RFC 7523 and SEP-1933 themselves allow assertion-only requests with no client identifier. The value is sent as plain public-client identification, so pick one your authorization server expects or ignores. `assertion` is either a static JWT string or a `WorkloadAssertionCallback` that returns one per token request, given `{ authorizationServerUrl, resourceUrl, scope, fetchFn }` for the MCP server the SDK just discovered. `scope` sets the requested scope, `expectedIssuer` pins the credential the same way it does for `ClientCredentialsProvider`, `clientName` sets the client metadata's display name, and `fetchFn` overrides the fetch implementation handed to the callback.

::: tip
The audience the assertion is minted for is authorization-server and profile specific. The MCP conformance profile for SEP-1933 expects the authorization server's issuer identifier, which is also where draft-ietf-oauth-rfc7523bis is heading (the draft itself permits either the issuer identifier or the token endpoint URL for authorization grants). In every case the audience names the authorization server, never the MCP server's resource URL: mint against `authorizationServerUrl`, not `resourceUrl`.
:::

`WorkloadIdentityProvider` is non-interactive: it has no `redirectUrl` and never falls back to an authorization-code grant. Once the authorization server rejects an assertion, the provider refuses to present that same assertion again; refusing that replay is what conformance calls `wif-no-retry`, and it surfaces as `WorkloadAssertionRejectedError`, so reach for a callback instead of a static string whenever the underlying token can expire or be revoked, and the callback should mint a fresh assertion on every call. There is no refresh token in this flow: a workload holding an expired or rejected JWT re-asserts by fetching a new platform-issued token, it does not refresh the MCP access token.

See [`examples/oauth-workload-identity`](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples/oauth-workload-identity) for a runnable, self-verifying end-to-end example.

## Recap

- Every flow on this page plugs in through the same `authProvider` option on `StreamableHTTPClientTransport`.
- `ClientCredentialsProvider` runs the `client_credentials` grant with a shared secret; `PrivateKeyJwtProvider` runs the same grant with a signed JWT assertion in its place.
- An `AuthProvider` with only `token()` is enough when something outside the SDK owns the token; without `onUnauthorized`, a 401 throws `UnauthorizedError`.
- `CrossAppAccessProvider` chains an enterprise IdP token through a JWT Authorization Grant to an MCP access token (SEP-990), and both exchanges are exported standalone.
- `WorkloadIdentityProvider` presents a platform-issued workload JWT (Kubernetes, SPIFFE, cloud identity tokens) directly as an RFC 7523 `jwt-bearer` assertion (SEP-1933); it never retries a rejected assertion unchanged and never falls back to an interactive grant.
- Authenticating an end user belongs on [OAuth](./oauth.md).
