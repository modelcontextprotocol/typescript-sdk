---
'@modelcontextprotocol/client': minor
---

Add `TokenProvider` for simple bearer-token authentication and export composable auth primitives

- New `TokenProvider` type — a minimal `() => Promise<string | undefined>` function interface for supplying bearer tokens. Use this instead of `OAuthClientProvider` when tokens are managed externally (gateway/proxy patterns, service accounts, upfront API tokens, or any scenario where the full OAuth redirect flow is not needed).
- New `tokenProvider` option on `StreamableHTTPClientTransport` and `SSEClientTransport`. Called before every request to obtain a fresh token. If both `authProvider` and `tokenProvider` are set, `authProvider` takes precedence.
- New `withBearerAuth(getToken, fetchFn?)` helper that wraps a fetch function to inject `Authorization: Bearer` headers — useful for composing with other fetch middleware.
- Exported previously-internal auth helpers for building custom auth flows: `applyBasicAuth`, `applyPostAuth`, `applyPublicAuth`, `executeTokenRequest`.
