# oauth (excluded)

The interactive **authorization-code** OAuth set, typecheck-only. Excluded from the harness (`package.json#example.excluded`) because the browser flow needs a real browser and a callback server on `:8090`.

- `server.ts` — an in-repo OAuth-protected MCP server: `setupAuthServer` (the better-auth/OIDC demo Authorization Server from `@mcp-examples/shared`) on `:3001`, and a `createMcpHandler` Resource Server behind `requireBearerAuth({ verifier: demoTokenVerifier })` on `:3000/mcp`,
  advertising the AS via `createProtectedResourceMetadataRouter`. DEMO ONLY — the AS auto-signs-in a fixed user.
- `simpleOAuthClient.ts` + `simpleOAuthClientProvider.ts` — full browser authorization-code flow against any OAuth-protected MCP server: opens the browser, runs a local callback server, exchanges the code, then drops into a small `list`/`call` REPL.
- `dualModeAuth.ts` — two auth patterns through the one `authProvider` option: host-managed bearer token vs a built-in `OAuthClientProvider`.
- `simpleTokenProvider.ts` — the minimal `AuthProvider` (just `token()`) for externally-managed bearer tokens.

## Run it manually

```bash
# terminal 1 — Authorization Server (:3001) + protected MCP Resource Server (:3000/mcp)
pnpm --filter @mcp-examples/oauth server

# terminal 2 — opens a browser to the demo AS, runs the callback server on :8090,
# exchanges the code, then drops into a list/call REPL against :3000/mcp
pnpm --filter @mcp-examples/oauth client
```

For the headless bearer-token resource-server case see `../bearer-auth/`; for the machine-to-machine `client_credentials` grant see `../oauth-client-credentials/`; for URL-mode elicitation see `../elicitation/`; for the interactive readline playground see `../repl/`.
