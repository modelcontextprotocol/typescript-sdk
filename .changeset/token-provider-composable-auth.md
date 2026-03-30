---
'@modelcontextprotocol/client': minor
---

Add `AuthProvider` for composable bearer-token auth; transports adapt `OAuthClientProvider` automatically

- New `AuthProvider` interface: `{ token(): Promise<string | undefined>; onUnauthorized?(ctx): Promise<void> }`. Transports call `token()` before every request and `onUnauthorized()` on 401 (then retry once).
- Transport `authProvider` option now accepts `AuthProvider | OAuthClientProvider`. OAuth providers are adapted internally via `adaptOAuthProvider()` — no changes needed to existing `OAuthClientProvider` implementations.
- For simple bearer tokens (API keys, gateway-managed tokens, service accounts): `{ authProvider: { token: async () => myKey } }` — one-line object literal, no class.
- New `adaptOAuthProvider(provider)` export for explicit adaptation.
- New `handleOAuthUnauthorized(provider, ctx)` helper — the standard OAuth `onUnauthorized` behavior.
- New `isOAuthClientProvider()` type guard.
- New `UnauthorizedContext` type.
- Exported previously-internal auth helpers for building custom flows: `applyBasicAuth`, `applyPostAuth`, `applyPublicAuth`, `executeTokenRequest`.

Transports are simplified internally — ~50 lines of inline OAuth orchestration (auth() calls, WWW-Authenticate parsing, circuit-breaker state) moved into the adapter's `onUnauthorized()` implementation. `OAuthClientProvider` itself is unchanged.
