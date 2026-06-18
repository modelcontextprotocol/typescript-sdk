# oauth (excluded)

The interactive authorization-code OAuth set, typecheck-only. Excluded from the harness (`package.json#example.excluded`) because the browser flow needs a real browser and a callback server on `:8090`.

- `simpleOAuthClient.ts` + `simpleOAuthClientProvider.ts` — full browser authorization-code flow against any OAuth-protected MCP server: opens the browser, runs a local callback server, exchanges the code, then drops into a small `list`/`call` REPL.
- `dualModeAuth.ts` — two auth patterns through the one `authProvider` option: host-managed bearer token vs a built-in `OAuthClientProvider`.
- `simpleTokenProvider.ts` — the minimal `AuthProvider` (just `token()`) for externally-managed bearer tokens.

For the headless bearer-token resource-server case see `../bearer-auth/`; for the machine-to-machine `client_credentials` grant see `../oauth-client-credentials/`; for URL-mode elicitation see `../mrtr/`; for the interactive readline playground see `../repl/`.
