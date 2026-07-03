---
shape: how-to
description: Integrate an MCP server with an Authorization Server you bring — a platform provider, an auth framework, or your IdP.
---

# Bring your own Authorization Server

Protecting a server with a token gate → [Require authorization](./authorization.md). Signing a user in from a client → [Authenticate a user with OAuth](../clients/oauth.md). This page covers the other half of the deployment: where the Authorization Server itself comes from, and how the SDK connects to it.

The SDK ships the Resource Server pieces only — verification, challenges, discovery — and no Authorization Server, deliberately: token issuance, consent, and client registration belong to dedicated systems. The AS you bring is typically your platform's (Cloudflare's [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)), an auth framework's (better-auth, in the [`oauth` example](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples/oauth)), or your organization's IdP. Two integration styles cover all of them.

## Style A: the Authorization Server fronts your handler

The AS wraps your deployment and verifies every API request before your code runs — `createMcpHandler` performs no verification of its own, so the integration is one option: map the identity the AS hands you into an `AuthInfo` and pass it in.

```ts source="../../examples/guides/serving/external-authorization-servers.examples.ts#styleA_injectAuthInfo"
// The fronting provider verified the token and hands your handler the identity
// it stored at grant time (workers-oauth-provider: `ctx.props`). Map it.
interface GrantProps {
    clientId: string;
    scopes: string[];
}

async function serveVerified(request: Request, props: GrantProps): Promise<Response> {
    const authInfo: AuthInfo = {
        token: request.headers.get('authorization')?.replace(/^Bearer /i, '') ?? '',
        clientId: props.clientId,
        scopes: props.scopes
        // No expiresAt: the provider enforces validity on every request.
    };
    return handler.fetch(request, { authInfo });
}
```

Every tool and resource handler now reads the identity as `ctx.http.authInfo`, and token expiry and revocation are enforced by the provider on each request — your code never sees an invalid token. One contract to know: fronting providers typically hand your handler only what was stored when the grant was approved, so embed everything `AuthInfo` needs (client id, scopes) into the grant at consent time.

::: info Running reference
The [`todos-server` example](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples/todos-server) deploys this style on Cloudflare Workers: `workers-oauth-provider` owns the endpoints, both discovery documents, dynamic client registration and Client ID Metadata Documents, and KV-backed grants — the app supplies a consent step and the `propsToAuthInfo` mapping (`oauth.ts`), and serves anonymous and token-authorized tiers side by side.
:::

## Style B: the SDK verifies tokens from an external AS

When the AS is elsewhere — an IdP issuing JWTs, or any issuer reachable for introspection — your server verifies each request itself: implement `OAuthTokenVerifier` against the issuer and put `requireBearerAuth` in front of the handler.

```ts source="../../examples/guides/serving/external-authorization-servers.examples.ts#styleB_externalVerifier"
// The AS is external (an IdP issuing JWTs): verify each request yourself.
const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token): Promise<AuthInfo> {
        const payload = await verifyJwtAgainstIssuer(token).catch(() => {
            throw new OAuthError(OAuthErrorCode.InvalidToken, 'unknown token');
        });
        return { token, clientId: payload.sub, scopes: payload.scopes, expiresAt: payload.exp };
    }
};
const gate = requireBearerAuth({ verifier, requiredScopes: ['mcp'] });

async function fetchHandler(request: Request): Promise<Response> {
    const auth = await gate(request);
    if (auth instanceof Response) return auth;
    return handler.fetch(request, { authInfo: auth });
}
```

A request with a missing, malformed, or expired token gets the `401` challenge; a valid one reaches handlers with `ctx.http.authInfo` populated from your verifier. [Require authorization](./authorization.md) covers the rest of this style's surface: the challenge contents, publishing protected resource metadata that names your external issuer, and per-tool scopes.

## Choosing a style

Style A fits when the AS can own your HTTP edge — a platform provider wrapping the worker, or an auth framework mounted in the same app. Style B fits when the AS is a remote system and your server is the edge: nothing fronts you, so you verify. They compose with the same application code either way — the factory receives `authInfo` identically, so switching styles later does not touch your tools.

## Recap

- The SDK is Resource-Server-only by design: bring the Authorization Server from your platform, framework, or IdP.
- Style A: the AS fronts you and verifies; inject its identity with `handler.fetch(request, { authInfo })`.
- Style B: the AS is external; verify per request with `OAuthTokenVerifier` + `requireBearerAuth`.
- Embed what `AuthInfo` needs into the grant at consent time — fronting providers replay only what was stored.
- The `todos-server` example runs Style A live; the `oauth` example runs an in-process better-auth AS.
