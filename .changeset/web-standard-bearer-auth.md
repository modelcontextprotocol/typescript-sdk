---
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/express': patch
'@modelcontextprotocol/codemod': patch
---

Add runtime-neutral Bearer authentication to `@modelcontextprotocol/server`:
`requireBearerAuth` gates web-standard `fetch(request)` hosts (Cloudflare
Workers, Deno, Bun, Hono), built on the exported `verifyBearerToken` and
`bearerAuthChallengeResponse` pieces, with `OAuthTokenVerifier` now defined
here. The Express middleware adapts the same core and is unchanged in
behavior; `@modelcontextprotocol/express` re-exports `OAuthTokenVerifier` as
before.
