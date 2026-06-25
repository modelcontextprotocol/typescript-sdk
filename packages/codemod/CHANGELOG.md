# @modelcontextprotocol/codemod

## 2.0.0-alpha.1

### Minor Changes

- [#2354](https://github.com/modelcontextprotocol/typescript-sdk/pull/2354) [`0fb8406`](https://github.com/modelcontextprotocol/typescript-sdk/commit/0fb8406d83a3578a12a605e1b43c352d565071b1) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - Route v1
  `@modelcontextprotocol/sdk/types.js` schema imports to the new `@modelcontextprotocol/core` package. The `*Schema` Zod constants now migrate as a behavior-preserving import-path swap — `<Name>Schema.parse(value)` / `.safeParse(value)` keep working — while spec types, error
  classes, enums, and guards continue to resolve to `@modelcontextprotocol/client` / `@modelcontextprotocol/server` by context. A single `import { CallToolResult, CallToolResultSchema } from '.../types.js'` is split accordingly. The v1 OAuth/OpenID `*Schema` constants imported
  from `@modelcontextprotocol/sdk/shared/auth.js` are routed to `@modelcontextprotocol/core` the same way (their auth TYPES keep resolving to `client` / `server`). The previous `specSchemaAccess` transform (which rewrote `.parse()` into
  `specTypeSchemas.X['~standard'].validate(...)`) is removed.

- [#2206](https://github.com/modelcontextprotocol/typescript-sdk/pull/2206) [`e03bca9`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e03bca90c1f925f80843dc27fb4eb2421408a0c1) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - Codemod now resolves SSE
  server and OAuth auth imports to @modelcontextprotocol/server-legacy sub-paths instead of removing them. An info diagnostic suggests eventual migration to v2 equivalents.

### Patch Changes

- [#2354](https://github.com/modelcontextprotocol/typescript-sdk/pull/2354) [`0fb8406`](https://github.com/modelcontextprotocol/typescript-sdk/commit/0fb8406d83a3578a12a605e1b43c352d565071b1) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - Infer client/server project
  type from source for v1 projects. A project being migrated still declares the single v1 `@modelcontextprotocol/sdk` dependency, so detecting the project type from `package.json` came back "unknown" and every file importing only shared protocol symbols defaulted to
  `@modelcontextprotocol/server` with an action-required warning. The codemod now scans the source for quoted `@modelcontextprotocol/sdk/client/…` and `…/server/…` import specifiers to infer the type (both → "both", one → that side, neither → "unknown"), routing shared symbols to
  the installed package and replacing the spurious warnings with at most an info note for genuinely ambiguous "both" projects.

- [#2137](https://github.com/modelcontextprotocol/typescript-sdk/pull/2137) [`542d5c9`](https://github.com/modelcontextprotocol/typescript-sdk/commit/542d5c95860c03d0c1a689f579b925250e25de6c) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - The v1→v2 codemod now
  migrates the removed `StreamableHTTPError` to `SdkHttpError` (instead of the base `SdkError`), matching the shipped error type and the migration guide. Diagnostics now point at the typed `error.status` / `error.statusText` accessors and note that unexpected-content-type
  responses are thrown as the base `SdkError`.

- [#2354](https://github.com/modelcontextprotocol/typescript-sdk/pull/2354) [`0fb8406`](https://github.com/modelcontextprotocol/typescript-sdk/commit/0fb8406d83a3578a12a605e1b43c352d565071b1) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - Map the task
  request/notification schemas to their v2 method strings in the handler-registration transform. `setRequestHandler(GetTaskRequestSchema, …)`, `setNotificationHandler(TaskStatusNotificationSchema, …)`, and the other task handlers (`tasks/get`, `tasks/result`, `tasks/list`,
  `tasks/cancel`, `notifications/tasks/status`) now rewrite to the v2 two-argument method-string form instead of falling through to the generic "use the 3-argument form" manual-migration diagnostic.

- [#2252](https://github.com/modelcontextprotocol/typescript-sdk/pull/2252) [`8d55531`](https://github.com/modelcontextprotocol/typescript-sdk/commit/8d55531dabd5aa2de8864d691520cd6c6fe77541) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add per-revision spec
  reference types (2025-11-25 and 2026-07-28) with split comparison tests, and the 2026-07-28 wire contract surface: request-meta key constants, `RequestMetaEnvelopeSchema`, `server/discover` shapes, the typed `-32004` error, the `-32003` code constant, and a `resultType`
  passthrough on the base result. Types and constants only — no behavior changes.
