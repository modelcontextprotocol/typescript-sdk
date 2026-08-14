---
shape: how-to
description: 'Require a bearer token on a server you run: verification, protected-resource metadata, and per-tool scopes.'
---

# Require authorization

Protecting a server you run → this page. Signing a user in from a client you build → [Authenticate a user with OAuth](../clients/oauth.md). No user present → [Authenticate without a user](../clients/machine-auth.md).

## Require a bearer token

Your MCP server is an OAuth **resource server**: it verifies access tokens that an authorization server issued, and it never issues them. `requireBearerAuth` from `@modelcontextprotocol/express` is that whole gate — build it from a verifier and mount it in front of the `/mcp` route from the [Express recipe](./express.md).

```ts source="../../examples/guides/serving/authorization.examples.ts#requireBearerAuth_basic"
import type { OAuthTokenVerifier } from '@modelcontextprotocol/express';
import {
    createMcpExpressApp,
    getOAuthProtectedResourceMetadataUrl,
    mcpAuthMetadataRouter,
    requireBearerAuth
} from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { AuthInfo, OAuthMetadata } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

const mcpServerUrl = new URL('https://api.example.com/mcp');
const verifier: OAuthTokenVerifier = { verifyAccessToken };

const auth = requireBearerAuth({
    verifier,
    requiredScopes: ['mcp'],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl)
});

const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: ['api.example.com'] });
const node = toNodeHandler(createMcpHandler(buildServer));
app.all('/mcp', auth, (req, res) => void node(req, res, req.body));
```

A request with a missing, malformed, or expired token gets `401` with the OAuth error code `invalid_token`. A valid token missing one of `requiredScopes` gets `403` with `insufficient_scope`. Both responses carry a `WWW-Authenticate: Bearer …` challenge whose `resource_metadata` parameter is the URL you passed — that challenge is what starts a client's OAuth flow.

::: info Coming from v1?
The Authorization Server helpers (`mcpAuthRouter`, `ProxyOAuthServerProvider`, …) are frozen in `@modelcontextprotocol/server-legacy/auth`. Use a dedicated identity provider for new servers; this page only covers the resource-server half.
:::

## Require a bearer token on a web-standard host

On hosts whose HTTP surface is a `fetch(request)` handler — Cloudflare Workers, Deno, Bun, Hono — the gate is `requireBearerAuth` from `@modelcontextprotocol/server`: no framework, only web-standard `Request` and `Response`.

```ts source="../../examples/guides/serving/authorization.web.examples.ts#requireBearerAuth_webStandard"
const gate = requireBearerAuth({ verifier, requiredScopes: ['mcp'] });
const handler = createMcpHandler(buildServer);

export default {
    async fetch(request: Request): Promise<Response> {
        const auth = await gate(request);
        if (auth instanceof Response) return auth;
        return handler.fetch(request, { authInfo: auth });
    }
};
```

The gate resolves to the verified `AuthInfo` — pass it to the handler as `{ authInfo }` and handlers read it as `ctx.http.authInfo` — or to the ready-to-return challenge `Response`. Status codes, error bodies, and the `WWW-Authenticate` challenge (including `resourceMetadataUrl`) are identical to the Express middleware: both are adapters over one core, so a verifier written for one serves the other unchanged.

## Verify tokens your way

`verifyAccessToken` is the one function you supply: take the raw token string, return an `AuthInfo`. Local JWT verification, [RFC 7662](https://datatracker.ietf.org/doc/html/rfc7662) introspection, or a call to your identity provider all fit behind it.

```ts source="../../examples/guides/serving/authorization.examples.ts#tokenVerifier_basic"
async function verifyAccessToken(token: string): Promise<AuthInfo> {
    const payload = await verifyJwt(token);
    return { token, clientId: payload.sub, scopes: payload.scopes, expiresAt: payload.exp };
}
```

Throw an `OAuthError` with `OAuthErrorCode.InvalidToken` (both from `@modelcontextprotocol/server`) for a token you reject, and `requireBearerAuth` turns it into the `401` challenge. Any other exception comes back as `500 server_error`.

::: warning
`requireBearerAuth` also answers `401 invalid_token` for a token whose `expiresAt` is unset. Always populate it — from the JWT `exp` claim or the introspection response's `exp` field.
:::

## Publish protected resource metadata

`mcpAuthMetadataRouter` serves the [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728) protected resource metadata document that the `401` challenge points at. `oauthMetadata` is your authorization server's own RFC 8414 metadata document.

```ts source="../../examples/guides/serving/authorization.examples.ts#metadataRouter_basic"
app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: mcpServerUrl }));
```

The router mounts two well-known routes: `/.well-known/oauth-protected-resource/mcp` — the path-aware RFC 9728 location, the same string `getOAuthProtectedResourceMetadataUrl(mcpServerUrl)` put into the challenge — and `/.well-known/oauth-authorization-server`, a mirror of `oauthMetadata` for clients that probe your origin directly. An unauthenticated client follows `401` → `resource_metadata` → `authorization_servers` to find your AS, obtains a token, and retries.

On a web-standard host, `oauthMetadataResponse` from `@modelcontextprotocol/server` serves the same two documents from a `fetch(request)` handler — it returns the matched document `Response` (with permissive CORS and `405` handling) or `undefined` to fall through to your own routing:

```ts source="../../examples/guides/serving/authorization.examples.ts#oauthMetadataResponse_webStandard"
import { oauthMetadataResponse } from '@modelcontextprotocol/server';

async function webStandardFetch(request: Request): Promise<Response> {
    return oauthMetadataResponse(request, { oauthMetadata, resourceServerUrl: mcpServerUrl }) ?? serveMcp(request);
}
```

## Read the caller in your handlers

`requireBearerAuth` attaches the verified `AuthInfo` to `req.auth`, `toNodeHandler` forwards it, and tool handlers inside `buildServer` read it as `ctx.http.authInfo` — the exact object your verifier returned.

```ts source="../../examples/guides/serving/authorization.examples.ts#authInfo_handler"
server.registerTool('whoami', { description: 'Report the authenticated caller' }, async ctx => {
    const caller = ctx.http?.authInfo;
    return { content: [{ type: 'text', text: `${caller?.clientId} [${caller?.scopes.join(' ')}]` }] };
});
```

`ctx.http` is `undefined` when the same server runs over [stdio](./stdio.md), so guard the read if your server serves both transports.

::: tip
The per-request factory itself receives the same value as `ctx.authInfo`, so it can register a different tool set per caller before any handler runs.
:::

## Enforce per-tool scopes

`requiredScopes` gates the whole endpoint. For a scope only some tools need, check inside the handler — the handler is the only place that knows which tool is executing.

```ts source="../../examples/guides/serving/authorization.examples.ts#perToolScopes_handler"
server.registerTool('purge-notes', { description: 'Delete every note' }, async ctx => {
    if (!ctx.http?.authInfo?.scopes.includes('notes:write')) {
        return { content: [{ type: 'text', text: 'insufficient_scope: purge-notes requires notes:write' }], isError: true };
    }
    return { content: [{ type: 'text', text: 'All notes deleted' }] };
});
```

A caller holding only `mcp` gets an ordinary tool result with `isError: true`, so the model reads the refusal and moves on instead of losing the connection.

::: info
Responding `403 insufficient_scope` at the HTTP layer instead triggers the client transport's automatic scope step-up (SEP-2350) — see [Authenticate a user with OAuth](../clients/oauth.md).
:::

## Recap

- `requireBearerAuth` from `@modelcontextprotocol/server` is the same gate for web-standard `fetch` hosts; the Express middleware adapts the same core.
- `requireBearerAuth` plus a `verifyAccessToken` you write turn an Express-mounted MCP route into an OAuth resource server; the SDK never issues tokens.
- Missing, invalid, or expired tokens get `401 invalid_token`; a token missing a `requiredScopes` entry gets `403 insufficient_scope`; both carry a `WWW-Authenticate: Bearer` challenge.
- `mcpAuthMetadataRouter` publishes the RFC 9728 document that challenge points at, plus a mirror of the AS metadata.
- Verified auth flows `req.auth` → `ctx.http.authInfo`; per-tool scopes are a check inside the handler that returns `isError: true`.
- The v1 Authorization Server helpers are frozen in `@modelcontextprotocol/server-legacy/auth`.
