# @modelcontextprotocol/core

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

## 2.0.0-alpha.2

### Major Changes

- [#2400](https://github.com/modelcontextprotocol/typescript-sdk/pull/2400) [`3c02ffb`](https://github.com/modelcontextprotocol/typescript-sdk/commit/3c02ffb5d9bb4da59028c70cc58987303b310074) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Align the published schema set with the 2026-07-28 surface: removes the
  `RequestMetaEnvelopeSchema` export; adds `SubscriptionFilterSchema`, the
  `SubscriptionsListen*` request/result schemas, and the
  `SubscriptionsAcknowledged*` notification schemas. The bundled schemas now
  match `@modelcontextprotocol/client` and `@modelcontextprotocol/server` of
  the same release.

## 2.0.0-alpha.1

### Minor Changes

- [#2354](https://github.com/modelcontextprotocol/typescript-sdk/pull/2354) [`0fb8406`](https://github.com/modelcontextprotocol/typescript-sdk/commit/0fb8406d83a3578a12a605e1b43c352d565071b1) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - Add
  `@modelcontextprotocol/core`: the public home for the MCP specification and OAuth/OpenID Zod schemas. It bundles the SDK's internal schema definitions and re-exports only the `*Schema` values, so consumers can validate protocol payloads (`<TypeName>Schema.parse(value)` /
  `.safeParse(value)`) without depending on a package's internal barrel. Alongside the spec schemas it also re-exports the auth schemas v1 exposed from `@modelcontextprotocol/sdk/shared/auth.js` (e.g. `OAuthTokensSchema`, `OAuthMetadataSchema`,
  `IdJagTokenExchangeResponseSchema`). Spec types, error classes, enums, and guards continue to live on `@modelcontextprotocol/server` and `@modelcontextprotocol/client`.
