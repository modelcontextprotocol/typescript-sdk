# oauth (excluded)

The interactive OAuth set: full browser authorization-code flow, URL-elicitation end-to-end, readline REPL clients, dual-mode auth (host token vs `OAuthClientProvider`), client_credentials / private-key-JWT. Typecheck-only — these need a browser, a callback server on `:8090`, and
(for client_credentials) an Authorization Server that doesn't ship in-repo.

Excluded from the harness (`manifest.json#excluded`); revisit after the auth-surface walk. For the headless bearer-token resource-server case see `../bearer-auth/`.
