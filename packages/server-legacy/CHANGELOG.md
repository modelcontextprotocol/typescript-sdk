# @modelcontextprotocol/server-legacy

## 2.0.0-beta.4

### Minor Changes

- [#2477](https://github.com/modelcontextprotocol/typescript-sdk/pull/2477) [`8e1d2e9`](https://github.com/modelcontextprotocol/typescript-sdk/commit/8e1d2e92b1720d2520122b3a5f20ea084edaf3c4) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Move the schema source modules (spec schemas, OAuth schemas, protocol constants) into `@modelcontextprotocol/core` and resolve them from there as a regular runtime dependency instead of bundling a private copy into each package. An application importing more than one of the packages now evaluates a single shared schema graph with shared object identity. `@modelcontextprotocol/core` gains a `./internal` subpath (SDK-internal contract; may change in any release) and the four packages now version together.

### Patch Changes

- [#2476](https://github.com/modelcontextprotocol/typescript-sdk/pull/2476) [`e0a0ab7`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e0a0ab74d9baed74572c9f435313fb6daef1b989) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Build protocol-revision wire schemas lazily on first validation instead of at import. Each revision's schema set is now constructed by a module-level memoized factory, so importing the client or server package no longer pays the construction cost of both frozen wire-schema graphs up front. Method membership in the revision registries stays static, the schemas themselves are unchanged, and registry lookups keep returning reference-identical schema objects.

- Updated dependencies [[`8e1d2e9`](https://github.com/modelcontextprotocol/typescript-sdk/commit/8e1d2e92b1720d2520122b3a5f20ea084edaf3c4)]:
    - @modelcontextprotocol/core@2.0.0-beta.4

## 2.0.0-beta.2

### Patch Changes

- [#2405](https://github.com/modelcontextprotocol/typescript-sdk/pull/2405) [`f172626`](https://github.com/modelcontextprotocol/typescript-sdk/commit/f172626a8e98b2ae2f0f690e4afb4dc74dbf6011) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Ship CommonJS builds alongside ESM. Each package now emits both `.mjs`/`.d.mts`
  and `.cjs`/`.d.cts` (via tsdown `format: ['esm', 'cjs']`), and its `exports` map
  adds a `require` condition so `require('@modelcontextprotocol/…')` works from
  CommonJS consumers. Output extensions are normalized across all packages
  (`@modelcontextprotocol/core` moves from `.js`/`.d.ts` to `.mjs`/`.d.mts`); the
  public import paths are unchanged.

## 2.0.0-beta.1

### Patch Changes

- [#2402](https://github.com/modelcontextprotocol/typescript-sdk/pull/2402) [`a400259`](https://github.com/modelcontextprotocol/typescript-sdk/commit/a4002596b914c675d17ac22471d1287976dbb52a) Thanks [@felixweinberger](https://github.com/felixweinberger)! - First beta release of SDK v2 with support for the MCP 2026-07-28 specification
  revision. See the migration guides for upgrading from v1
  (`docs/migration/upgrade-to-v2.md`) and adopting the 2026-07-28 revision
  (`docs/migration/support-2026-07-28.md`).

## 2.0.0-alpha.4

### Minor Changes

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - SEP-2468 follow-up: `transport.finishAuth()` gains a `URLSearchParams` overload (preferred) that extracts `code`/`iss`, validates `iss` first, and on mismatch throws a sanitized `IssuerMismatchError` (no callback `error_description` text); callers remain responsible for `state`. **Behavior change for `@modelcontextprotocol/server-legacy`:** `mcpAuthRouter` now advertises `authorization_response_iss_parameter_supported` (default `true`; `ProxyOAuthServerProvider` reports `false`) and the bundled authorize handler appends `iss` (RFC 9207) to every `res.redirect(...)` your `OAuthServerProvider.authorize()` issues to the client's `redirect_uri`. If your provider redirects another way (`res.writeHead`, a separate consent-page response, or a standalone `authorizationHandler({provider})` without `issuerUrl`), append `params.issuer` as `iss` yourself or set `authorizationResponseIssParameterSupported: false` — otherwise RFC 9207-compliant clients (including this SDK) will reject the callback.

## 2.0.0-alpha.3

### Minor Changes

- [#2206](https://github.com/modelcontextprotocol/typescript-sdk/pull/2206) [`e03bca9`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e03bca90c1f925f80843dc27fb4eb2421408a0c1) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - Add
  @modelcontextprotocol/server-legacy package with frozen v1 SSE transport and OAuth Authorization Server helpers for migration from v1 to v2.
