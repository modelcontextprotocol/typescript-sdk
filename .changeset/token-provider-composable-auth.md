---
'@modelcontextprotocol/client': major
---

Unify client auth around a minimal `AuthProvider` interface

**Breaking:** Transport `authProvider` option now accepts the new minimal `AuthProvider` interface instead of being typed as `OAuthClientProvider`. `OAuthClientProvider` now extends `AuthProvider`, so most existing code continues to work — but custom implementations must add a `token()` method.

- New `AuthProvider` interface: `{ token(): Promise<string | undefined>; onUnauthorized?(ctx): Promise<void> }`. Transports call `token()` before every request and `onUnauthorized()` on 401 (then retry once).
- `OAuthClientProvider` extends `AuthProvider`. Custom implementations must add `token()` (typically `return (await this.tokens())?.access_token`) and optionally `onUnauthorized()` (typically `return handleOAuthUnauthorized(this, ctx)`).
- Built-in providers (`ClientCredentialsProvider`, `PrivateKeyJwtProvider`, `StaticPrivateKeyJwtProvider`, `CrossAppAccessProvider`) implement both methods — existing user code is unchanged.
- New `handleOAuthUnauthorized(provider, ctx)` helper runs the standard OAuth flow from `onUnauthorized`.
- New `isOAuthClientProvider()` type guard for gating OAuth-specific transport features like `finishAuth()`.
- Transports no longer inline OAuth orchestration — ~50 lines of `auth()` calls, WWW-Authenticate parsing, and circuit-breaker state moved into `onUnauthorized()` implementations.
- Exported previously-internal auth helpers for building custom flows: `applyBasicAuth`, `applyPostAuth`, `applyPublicAuth`, `executeTokenRequest`.

See `docs/migration.md` for before/after examples.
