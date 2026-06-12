# @modelcontextprotocol/codemod

## 2.0.0-alpha.1

### Minor Changes

- [#2206](https://github.com/modelcontextprotocol/typescript-sdk/pull/2206) [`e03bca9`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e03bca90c1f925f80843dc27fb4eb2421408a0c1) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - Codemod now resolves SSE
  server and OAuth auth imports to @modelcontextprotocol/server-legacy sub-paths instead of removing them. An info diagnostic suggests eventual migration to v2 equivalents.

### Patch Changes

- [#2137](https://github.com/modelcontextprotocol/typescript-sdk/pull/2137) [`542d5c9`](https://github.com/modelcontextprotocol/typescript-sdk/commit/542d5c95860c03d0c1a689f579b925250e25de6c) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - The v1→v2 codemod now
  migrates the removed `StreamableHTTPError` to `SdkHttpError` (instead of the base `SdkError`), matching the shipped error type and the migration guide. Diagnostics now point at the typed `error.status` / `error.statusText` accessors and note that unexpected-content-type
  responses are thrown as the base `SdkError`.

- [#2252](https://github.com/modelcontextprotocol/typescript-sdk/pull/2252) [`8d55531`](https://github.com/modelcontextprotocol/typescript-sdk/commit/8d55531dabd5aa2de8864d691520cd6c6fe77541) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add per-revision spec
  reference types (2025-11-25 and 2026-07-28) with split comparison tests, and the 2026-07-28 wire contract surface: request-meta key constants, `RequestMetaEnvelopeSchema`, `server/discover` shapes, the typed `-32004` error, the `-32003` code constant, and a `resultType`
  passthrough on the base result. Types and constants only — no behavior changes.
