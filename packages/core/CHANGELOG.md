# @modelcontextprotocol/core

## 2.0.0-beta.5

### Minor Changes

- [#2513](https://github.com/modelcontextprotocol/typescript-sdk/pull/2513) [`f413763`](https://github.com/modelcontextprotocol/typescript-sdk/commit/f4137630c05dc9a4fb14d4d3777f5cb167bd6313) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Align the 2026-07-28 wire with the final revision (spec PR #3002): `serverInfo` moves from the `DiscoverResult` body to the result `_meta`, and the per-request envelope's `clientInfo` demotes from required to SHOULD.

    Before this change the SDK shipped the pre-#3002 shape in both directions: the client hard-rejected a conforming server's `DiscoverResult` (missing body `serverInfo` failed parse, so the probe misclassified the server as legacy and attempted an `initialize` handshake against it — a hard connect failure against a modern-only server such as go-sdk v1.7.0-pre.3), and the server rejected conforming clients that omit `clientInfo`.

    Now:
    - The 2026 wire schemas are the final revision exactly: no body `serverInfo` on `DiscoverResult`, envelope `clientInfo` optional (a present-but-malformed value still fails validation).
    - Servers stamp `_meta['io.modelcontextprotocol/serverInfo']` on every 2026-era response (spec SHOULD; a handler-authored value wins, the 2025-era wire is untouched). This includes the entry-built `subscriptions/listen` graceful-close results — the spec's `SubscriptionsListenResultMeta` extends `ResultMetaObject`.
    - Clients keep sending `clientInfo` and read server identity from the discover result's `_meta` only. A server that stamps no identity is anonymous: `getServerVersion()` is `undefined` and the response cache partitions under a per-connection surrogate. A malformed `_meta` serverInfo value is treated as absent on receive (the spec marks the field self-reported, unverified, and display-only).
    - Breaking type changes: `DiscoverResult` no longer declares `serverInfo`; `RequestMetaEnvelope`'s `clientInfo` is optional. New public constant `SERVER_INFO_META_KEY` (`'io.modelcontextprotocol/serverInfo'`).

## 2.0.0-beta.4

### Minor Changes

- [#2477](https://github.com/modelcontextprotocol/typescript-sdk/pull/2477) [`8e1d2e9`](https://github.com/modelcontextprotocol/typescript-sdk/commit/8e1d2e92b1720d2520122b3a5f20ea084edaf3c4) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Move the schema source modules (spec schemas, OAuth schemas, protocol constants) into `@modelcontextprotocol/core` and resolve them from there as a regular runtime dependency instead of bundling a private copy into each package. An application importing more than one of the packages now evaluates a single shared schema graph with shared object identity. `@modelcontextprotocol/core` gains a `./internal` subpath (SDK-internal contract; may change in any release) and the four packages now version together.

## 2.0.0-beta.3

### Patch Changes

- [#2456](https://github.com/modelcontextprotocol/typescript-sdk/pull/2456) [`44797d7`](https://github.com/modelcontextprotocol/typescript-sdk/commit/44797d77792953d0ce70b68922bb6bb69e697c32) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Restore the v1 parse tolerance for `CallToolResult.content`: an inbound legacy-era `tools/call` result without `content` defaults to `[]` instead of failing validation. Deployed servers — accepted by SDK v1 for years — return `structuredContent`-only (or otherwise content-less) results, and the strict parse turned every such call into an `INVALID_RESULT` error before application code could run.

    The silent-empty-success hazard the strictness guarded is preserved where it matters: the 2025 era's wire-seam schema refuses to default `content` for a body carrying another result family's vocabulary (`task`, `inputRequests`, `requestState` — the era is frozen, so the list is complete), and the 2026-era wire schemas stay strict — modern-revision servers have no legacy excuse. Task interop through an explicit result schema is untouched (including bodies that also stamp a foreign `resultType`), and the server-side authoring normalization refuses the same foreign-family vocabulary.

    Server-side authoring is era-independent: a handler result without `content` (dynamic/JS callers — the TypeScript surface requires it) is normalized to `content: []` before era validation on every leg, reaching the wire spec-valid.

    Conscious call: the nested sampling `ToolResultContentSchema` stays spec-strict — v1 had defaulted its `content` too, but it is params-side (tool results a caller authors into a sampling message), deliberately not restored.

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
