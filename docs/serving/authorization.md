---
status: scaffold
shape: how-to
---
# Require authorization

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Bearer auth, PRM metadata, per-tool scopes. Opens with the one-line auth router.
teaches: requireBearerAuth, OAuthTokenVerifier, mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl, ctx.http.authInfo, per-tool scope checks
source: mined from docs/server.md "Authorization (OAuth resource server)" (the best long example in the set — lens 89); examples/scoped-tools/README.md; examples/bearer-auth/
-->

<!-- opening (before any H2) — the one-line auth router, mandatory:
Protecting a server you run -> this page. Signing a user in from a client -> /clients/oauth. No user present -> /clients/machine-auth. -->

## Require a bearer token
<!-- teaches: requireBearerAuth({ verifier, requiredScopes, resourceMetadataUrl }) in front of the MCP route; your server is an OAuth RESOURCE server — it verifies tokens, it never issues them | salvage: docs/server.md "Authorization (OAuth resource server)" lead -->

```ts
// draft - API verified against packages/middleware/express/src/auth/bearerAuth.ts (requireBearerAuth) and packages/middleware/express/src/auth/metadataRouter.ts (getOAuthProtectedResourceMetadataUrl)
import { getOAuthProtectedResourceMetadataUrl, requireBearerAuth } from '@modelcontextprotocol/express';

// continuing from the Express recipe: `verifier`, `app`, and `node` already exist
const mcpServerUrl = new URL('https://api.example.com/mcp');

const auth = requireBearerAuth({
  verifier,
  requiredScopes: ['mcp'],
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl),
});

app.all('/mcp', auth, (req, res) => void node(req, res, req.body));
```
<!-- result: one line — a request without a valid token gets 401 invalid_token with a WWW-Authenticate: Bearer challenge -->

## Verify tokens your way
<!-- teaches: OAuthTokenVerifier — verifyAccessToken(token) -> AuthInfo; JWT verification, RFC 7662 introspection, or a call to your IdP | salvage: docs/server.md auth_resourceServer region (verifier half) -->
<!-- code: const verifier: OAuthTokenVerifier = { async verifyAccessToken(token) { ... return { token, clientId, scopes, expiresAt } } } -->

## Publish protected resource metadata
<!-- teaches: mcpAuthMetadataRouter serves /.well-known/oauth-protected-resource (RFC 9728) so clients can discover your AS; the 401 challenge's resource_metadata points at it | salvage: docs/server.md auth_resourceServer region (metadata half) -->
<!-- code: app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: mcpServerUrl })) -->

## Read the caller in your handlers
<!-- teaches: requireBearerAuth sets req.auth; toNodeHandler forwards it; tool handlers read ctx.http.authInfo and factories read ctx.authInfo | salvage: docs/server.md "requireBearerAuth attaches the verified AuthInfo..." paragraph -->
<!-- code: async (args, ctx) => { const who = ctx.http?.authInfo?.clientId; ... } -->

## Enforce per-tool scopes
<!-- teaches: requiredScopes gates the whole endpoint; per-tool scopes are checked in the handler against ctx.http?.authInfo?.scopes, returning isError with insufficient_scope | salvage: examples/scoped-tools/README.md -->
<!-- code: if (!ctx.http?.authInfo?.scopes?.includes('files:write')) return { content: [...], isError: true } -->
<!-- aside: SEP-2350 scope step-up (the client retries after a 403 insufficient_scope challenge) — one line, link /clients/oauth -->

## Recap
<!-- the claims this page proves:
- requireBearerAuth + an OAuthTokenVerifier turn any Express-mounted MCP route into an OAuth resource server.
- The SDK never issues tokens; AS helpers live frozen in @modelcontextprotocol/server-legacy/auth.
- mcpAuthMetadataRouter publishes the RFC 9728 document the 401 challenge points at.
- Validated auth flows req.auth -> ctx.http.authInfo; per-tool scopes are a handler check.
-->
