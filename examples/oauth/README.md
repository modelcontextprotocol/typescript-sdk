# oauth

The **authorization-code** OAuth grant — the interactive "user signs in and approves" flow — against an in-repo OAuth-protected MCP server.

- `server.ts` — `setupAuthServer` (the better-auth/OIDC demo Authorization Server from `@mcp-examples/shared`) on `:PORT+1`, and a `createMcpHandler` Resource Server behind `requireBearerAuth({ verifier: demoTokenVerifier })` on `:PORT/mcp`, advertising the AS via
  `createProtectedResourceMetadataRouter` (RFC 9728). DEMO ONLY — the AS auto-signs-in a fixed user, and with `OAUTH_DEMO_AUTO_CONSENT=1` it also auto-approves the consent screen.
- `client.ts` — **CI-runnable headless flow.** Drives the same SDK auth machinery as the browser client, but instead of `open()`ing the authorization URL it follows the 302 chain itself with `fetch(..., { redirect: 'manual' })` (the demo AS's auto-sign-in + auto-consent collapse
  every interactive step into a redirect), reads the `code` off the final `Location` header, calls `transport.finishAuth(code)`, reconnects, and asserts `ctx.authInfo` round-trips. This is what the harness runs.
- `simpleOAuthClient.ts` + `simpleOAuthClientProvider.ts` — **manual real-browser flow.** Full authorization-code flow against any OAuth-protected MCP server: opens the browser, runs a local callback server on `:8090`, exchanges the code, then drops into a small `list`/`call`
  REPL. Run this when you want to see the consent page.
- `dualModeAuth.ts` — two auth patterns through the one `authProvider` option: host-managed bearer token vs a built-in `OAuthClientProvider`.
- `simpleTokenProvider.ts` — the minimal `AuthProvider` (just `token()`) for externally-managed bearer tokens.

## Run it

```bash
# headless (what CI does) — terminal 1: AS (:3001) + protected RS (:3000/mcp), auto-consent on
OAUTH_DEMO_AUTO_CONSENT=1 pnpm --filter @mcp-examples/oauth server
# terminal 2: follows the 302 chain, exchanges the code, asserts whoami
pnpm --filter @mcp-examples/oauth client -- --http http://127.0.0.1:3000/mcp

# manual real-browser flow — terminal 1: same server (auto-consent optional)
pnpm --filter @mcp-examples/oauth server
# terminal 2: opens a browser to the demo AS, callback server on :8090, then a list/call REPL
pnpm --filter @mcp-examples/oauth client:browser
```

For the headless bearer-token resource-server case see `../bearer-auth/`; for the machine-to-machine `client_credentials` grant see `../oauth-client-credentials/`; for URL-mode elicitation see `../elicitation/`; for the interactive readline playground see `../repl/`.
