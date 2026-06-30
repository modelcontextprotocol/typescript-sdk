# @modelcontextprotocol/core

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
