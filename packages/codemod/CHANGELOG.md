# @modelcontextprotocol/codemod

## 2.0.0-beta.4

### Patch Changes

- [#2486](https://github.com/modelcontextprotocol/typescript-sdk/pull/2486) [`ee8267a`](https://github.com/modelcontextprotocol/typescript-sdk/commit/ee8267af4a55efda3cebdb35a1ebb1d797e4235d) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Version the codemod together with the core SDK packages, matching the migration guide's shared-version guarantee.

## 2.0.0-beta.3

### Patch Changes

- [#2419](https://github.com/modelcontextprotocol/typescript-sdk/pull/2419) [`79dc162`](https://github.com/modelcontextprotocol/typescript-sdk/commit/79dc162efcb4e1f7b820bfb6068906483cf71ec7) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Read the v2 package versions the codemod writes into migrated `package.json` files directly from the workspace manifests at build time, replacing the committed generated `versions.ts` (which went stale after every release and made source builds write outdated versions).

- [#2420](https://github.com/modelcontextprotocol/typescript-sdk/pull/2420) [`7635115`](https://github.com/modelcontextprotocol/typescript-sdk/commit/7635115d0112c3f980b45a9773a4770660af8aae) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add runtime-neutral Bearer authentication to `@modelcontextprotocol/server`:
  `requireBearerAuth` gates web-standard `fetch(request)` hosts (Cloudflare
  Workers, Deno, Bun, Hono), built on the exported `verifyBearerToken` and
  `bearerAuthChallengeResponse` pieces, with `OAuthTokenVerifier` now defined
  here. The Express middleware adapts the same core and is unchanged in
  behavior, except that `WWW-Authenticate` challenge values are now RFC 7235
  quoted-string sanitized (quotes and backslashes escaped, control and
  non-ASCII characters replaced); `@modelcontextprotocol/express` re-exports
  `OAuthTokenVerifier` as before.

## 2.0.0-beta.2

### Patch Changes

- [#2405](https://github.com/modelcontextprotocol/typescript-sdk/pull/2405) [`f172626`](https://github.com/modelcontextprotocol/typescript-sdk/commit/f172626a8e98b2ae2f0f690e4afb4dc74dbf6011) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Ship CommonJS builds alongside ESM. Each package now emits both `.mjs`/`.d.mts`
  and `.cjs`/`.d.cts` (via tsdown `format: ['esm', 'cjs']`), and its `exports` map
  adds a `require` condition so `require('@modelcontextprotocol/…')` works from
  CommonJS consumers. Output extensions are normalized across all packages
  (`@modelcontextprotocol/core` moves from `.js`/`.d.ts` to `.mjs`/`.d.mts`); the
  public import paths are unchanged.

- [#2412](https://github.com/modelcontextprotocol/typescript-sdk/pull/2412) [`ef120b2`](https://github.com/modelcontextprotocol/typescript-sdk/commit/ef120b2be0c3c3d80468c3d4a9f79be30bb0c0a3) Thanks [@felixweinberger](https://github.com/felixweinberger)! - v1-to-v2 migration fixes from continued real-world migrations (codemod iterations 5).

## 2.0.0-beta.1

### Patch Changes

- [#2402](https://github.com/modelcontextprotocol/typescript-sdk/pull/2402) [`a400259`](https://github.com/modelcontextprotocol/typescript-sdk/commit/a4002596b914c675d17ac22471d1287976dbb52a) Thanks [@felixweinberger](https://github.com/felixweinberger)! - First beta release of SDK v2 with support for the MCP 2026-07-28 specification
  revision. See the migration guides for upgrading from v1
  (`docs/migration/upgrade-to-v2.md`) and adopting the 2026-07-28 revision
  (`docs/migration/support-2026-07-28.md`).

## 2.0.0-alpha.2

### Minor Changes

- [#2393](https://github.com/modelcontextprotocol/typescript-sdk/pull/2393) [`e4e8b22`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e4e8b22dff6c48b9a46fd960c9171aed44a996a8) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Three migration-sweep fixes. `completable()` calls whose first argument is an optional-wrapped schema are rewritten to apply `.optional()` to the `completable(...)` result — v2 resolves completion metadata after unwrapping an outer optional wrapper, so the v1 nesting produced empty completion lists without an error; wrapper shapes the codemod cannot invert get an action-required marker instead. Imports of `Protocol` and `mergeCapabilities` from v1's `shared/protocol.js` are no longer rewritten to a member the v2 packages do not export: the symbols are dropped from the rewritten import and an action-required marker explains the replacement (`fallbackRequestHandler` for unrouted inbound requests; a plain object spread for capability merging). The manifest zod-range warning now describes the symptom by vintage — zod 4.0–4.1 ranges fail type-checking (TS2769), while zod-3 ranges fail type-checking or at the first `tools/list` depending on the imported zod entry point.

- [#2393](https://github.com/modelcontextprotocol/typescript-sdk/pull/2393) [`e4e8b22`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e4e8b22dff6c48b9a46fd960c9171aed44a996a8) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Migration-sweep batch. The ErrorCode split now coordinates with the surrounding check: an all-SDK condition's `instanceof ProtocolError`/`McpError` guard is rewritten to `SdkError`, a guard covering both enums gets a marker asking for a split, and an `ErrorCode` import with no rewritable member access on a v2 specifier is dropped with a marker instead of failing at module link time. Wrapping a raw shape with `z.object()` adds `import { z } from 'zod'` when the file has no `z` value binding (a non-import `z` binding gets a marker instead). The context-parameter rewrite finds the trailing `extra` parameter, covering the three-argument `registerResource` template callback without flagging its `variables` argument. Resource-server auth helpers routed to the frozen server-legacy copy get a marker on value imports and barrel re-exports (an info note for type-only imports), every rewritten `SdkHttpError` constructor site gets a marker, and single-argument `finishAuth(...)` calls in files the run changes get a run-log note (the one-argument `URLSearchParams` form is valid v2, so the note never re-fires on already-migrated trees). The codemod accepts a single source file as target — source rewrites scope to that file and manifest changes are reported, not applied — and the no-changes summary distinguishes "already on the v2 packages", "still on the v1 SDK under a transform subset", and "no MCP SDK imports found".

- [#2393](https://github.com/modelcontextprotocol/typescript-sdk/pull/2393) [`e4e8b22`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e4e8b22dff6c48b9a46fd960c9171aed44a996a8) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Overhaul manifest handling. The codemod now discovers workspace-member manifests (npm/yarn/bun `workspaces` and `pnpm-workspace.yaml`), writes only the nearest `package.json`, and reports the exact dependency changes every other affected manifest needs, so you can apply them deliberately. The v2 additions are computed from the post-transform import state of the files each manifest owns, so already-migrated packages still receive the packages their imports need when the v1 dependency is removed; in hoisted monorepos, member usage counts toward the manifest that declares the SDK dependency, with a note naming the contributing members. File collection no longer follows symbolic links (pnpm `node_modules` layouts contain cycles that previously aborted the run) and honors `--ignore` patterns during directory descent. Manifests whose `zod` range cannot satisfy the v2 floor get a warning describing the runtime failure mode. `RunnerResult.packageJsonChanges` is now an array of per-manifest changes with optional `warnings` and `notes`.

### Patch Changes

- [#2393](https://github.com/modelcontextprotocol/typescript-sdk/pull/2393) [`e4e8b22`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e4e8b22dff6c48b9a46fd960c9171aed44a996a8) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Backlog fixes. When the zod import injection fires in a package that declares no zod, the manifest pass adds it (devDependencies when only tests import it) so strict node_modules layouts install cleanly. The ErrorCode-split pairing re-points stale `as ProtocolError`/`as McpError` casts bound to subjects whose assertions it moves to `SdkError`. Handler registration resolves one same-file variable hop (`const S = ListToolsRequestSchema`) before declaring a schema custom. Shorthand and aliased destructures of SDK dynamic imports rename with the static-import pass. Call-shape assertions pinning a registration schema (`expect.objectContaining({ inputSchema: … })`) get an advisory. The guide covers dist-text pins (no CJS-resolvable subpaths, content-hashed chunks, changed quote style, ESM-only output).

- [#2393](https://github.com/modelcontextprotocol/typescript-sdk/pull/2393) [`e4e8b22`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e4e8b22dff6c48b9a46fd960c9171aed44a996a8) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Fixes from migrating two large consumers. Registrations nested inside another handler's body no longer crash the transform with a whole-file rollback (calls process inner-first). Legacy `.tool()`/`.prompt()`/`.resource()` calls migrate without a direct `McpServer` import when their shape matches the v1 signature AND the receiver is named like an MCP server (`server`, `harness.mcp`, `this.mockServer`); other receivers are left alone, without hard markers, since their type is unknown to the codemod. `setRequestHandler`/`setNotificationHandler` with a schema _expression_ first argument get a marker pointing at the typed two-argument or custom three-argument form instead of being skipped silently, and `removeRequestHandler`/`removeNotificationHandler` with `Schema.shape.method.value` arguments rewrite to the method string. Destructured trailing callback parameters only count as the context when their keys look like context members, so template-variable destructures stop collecting false markers. The manifest zod note only appears for manifests that actually take part in the migration.

- [#2393](https://github.com/modelcontextprotocol/typescript-sdk/pull/2393) [`e4e8b22`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e4e8b22dff6c48b9a46fd960c9171aed44a996a8) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Two long-standing intervention classes now migrate mechanically. `.code` reads on values an `instanceof SdkHttpError` check proves — in the same condition or the guarded block — rewrite to `.status` (v2 carries the HTTP status there; `.code` is an `SdkErrorCode` string); unprovable reads keep the existing warning. The context-property remap reaches three shapes the call-site scan missed: functions assigned to `fallbackRequestHandler`, parameters annotated with a context type directly or via a same-file alias (accesses remap in place, the parameter keeps its name), and contexts forwarded wholesale to helpers, which get an advisory naming the callee.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - The v1→v2 codemod no longer rewrites `taskStore`/`taskMessageQueue` McpServer constructor options into `capabilities.tasks` — that target does not exist in v2 (the experimental tasks runtime was removed, SEP-2663). The codemod now leaves the code untouched and emits an action-required diagnostic telling migrators to remove the option, matching the removal guidance already given for `experimental/tasks` imports and the migration guide.

- [#2386](https://github.com/modelcontextprotocol/typescript-sdk/pull/2386) [`36055d5`](https://github.com/modelcontextprotocol/typescript-sdk/commit/36055d5bbd1d078922aa025acea6880e61a20577) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - Preserve a leading `#!` shebang (and the blank lines after it) when migrating a file. Some transforms drop the shebang because it is leading trivia of the first import they rewrite; the codemod now captures it before transforms and restores it before saving, so CLI packages whose `bin` points at the migrated entry keep working.

- [#2393](https://github.com/modelcontextprotocol/typescript-sdk/pull/2393) [`e4e8b22`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e4e8b22dff6c48b9a46fd960c9171aed44a996a8) Thanks [@felixweinberger](https://github.com/felixweinberger)! - The explicit-`undefined` result-schema removal now requires the same proof as the schema-identifier path: `request()` calls must carry a provably literal spec method, and `callTool()` calls whose first argument is a primitive are left alone. Previously, any file importing an MCP package could have the middle argument deleted from an unrelated `.request()` / `.callTool()` member call on a non-SDK receiver (e.g. a bespoke `end.request('ping', undefined, id)` helper), corrupting the call.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - v1-to-v2: now wraps `outputSchema` raw shapes with `z.object()`; importMap covers `sdk/server/express.js`, `sdk/server/middleware/hostHeaderValidation.js`, and `sdk/client/auth-extensions.js`. The unreachable `expressMiddleware` transform is removed.

- [#2383](https://github.com/modelcontextprotocol/typescript-sdk/pull/2383) [`9f8ba61`](https://github.com/modelcontextprotocol/typescript-sdk/commit/9f8ba6127989c371cccf0dbb72ef0cbf4726f9b0) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Keep the result-schema argument on `request()` calls unless the method is a literal spec method, and keep the generic passthrough `ResultSchema` even then. Schema-less v2 `request()` enforces the spec result schema for spec methods and throws a `TypeError` for non-spec methods, so dropping the schema from a dynamic-method call site (the proxy/forwarder shape, `request({ method, params }, ResultSchema)`) or from a custom-method call broke the call. `callTool()` is unaffected — v2 `callTool()` has no schema parameter.

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
