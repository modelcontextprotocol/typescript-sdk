---
name: mcp-typescript-sdk-upgrade-to-v2
description: 'Upgrades TypeScript code from v1 of the MCP TypeScript SDK (`@modelcontextprotocol/sdk`) to v2 (`@modelcontextprotocol/client`, `/server`, `/core` and the middleware packages): runs the official codemod, then works through what it cannot rewrite. Use whenever a project depends on `@modelcontextprotocol/sdk` and the user wants to migrate, upgrade, port or bump it to v2, or is fixing v1-to-v2 breakage such as missing `McpError`, `RequestHandlerExtra` or `*Schema` exports, `@mcp-codemod-error` markers, or changed auth, error, transport or handler behavior, even if they do not say "migration".'
---

<!-- #region intro -->

# Upgrading from v1.x to v2

This guide covers upgrading from `@modelcontextprotocol/sdk` (v1.x) to the v2 packages.
It is written for shell-capable agents and humans alike: run the codemod first, then
work through the manual sections for what the codemod can't rewrite.

If you are already on v2 and want to adopt the **2026-07-28 protocol revision**, see
[support-2026-07-28.md](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.md) instead.

## TL;DR — quick path

1. **Prerequisites.** Node.js 20+. v2 is ESM-first but ships a CommonJS build too, so
   both `import` and `require('@modelcontextprotocol/…')` resolve natively.
2. **Run the codemod.**
    ```bash
    npx @modelcontextprotocol/codemod@latest v1-to-v2 .
    ```
    Run it at the **package root** (`.`), not `./src` — it also rewrites `package.json`,
    and real projects import the SDK from `test/`, `scripts/`, and fixtures too.
3. **Grep for markers.** Anything the codemod recognized but could not safely rewrite is
   marked in place:
    ```bash
    grep -rn '@mcp-codemod-error' .
    ```
4. **Type-check.** `tsc --noEmit` (or your build). Remaining errors map to the
   [manual sections](#manual-changes-what-the-codemod-does-not-handle) below.
5. **Format.** The codemod rewrites the AST without reformatting — run your formatter on
   the changed files (`prettier --write` / `eslint --fix` / `biome format --write`); the
   codemod prints the exact command after it runs.
6. **Run your tests.**

Migrating a large codebase gradually instead of in one pass? See
[Migrating in stages (large codebases)](references/packaging-runtime.md#migrating-in-stages-large-codebases).

<!-- #endregion intro -->

<!-- #region codemod -->

## What the codemod handles

The codemod ([`@modelcontextprotocol/codemod`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/codemod/README.md))
mechanically applies every rename whose mapping is fixed. The mappings are the
**source of truth** — they live in the codemod package and are not reproduced here:

| Mapping                                                                                   | Source file                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@modelcontextprotocol/sdk/...` import paths → v2 packages                                | [`mappings/importMap.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/codemod/src/migrations/v1-to-v2/mappings/importMap.ts)                   |
| Symbol renames (`McpError` → `ProtocolError`, `JSONRPCError` → `JSONRPCErrorResponse`, …) | [`mappings/symbolMap.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/codemod/src/migrations/v1-to-v2/mappings/symbolMap.ts)                   |
| `setRequestHandler(Schema, …)` → `setRequestHandler('method/string', …)`                  | [`mappings/schemaToMethodMap.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/codemod/src/migrations/v1-to-v2/mappings/schemaToMethodMap.ts)   |
| `extra.*` → `ctx.mcpReq.*` / `ctx.http?.*` property remap                                 | [`mappings/contextPropertyMap.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/codemod/src/migrations/v1-to-v2/mappings/contextPropertyMap.ts) |

In addition the codemod:

- Updates `package.json` dependencies (`@modelcontextprotocol/sdk` → the v2 packages
  your imports actually use).
- Rewrites `.tool()` / `.prompt()` / `.resource()` to `registerTool` / `registerPrompt`
  / `registerResource` and wraps `inputSchema` / `outputSchema` / `argsSchema` /
  `uriSchema` raw Zod shapes with `z.object()`, adding `import { z } from 'zod'`
  when the file has no `z` binding.
- Drops the result-schema argument from `client.request()` / `client.callTool()` for
  spec methods.
- Routes the spec Zod `*Schema` constants imported from `sdk/types.js` to
  `@modelcontextprotocol/core` (mixed imports are split; `.parse()` / `.safeParse()`
  calls are left untouched). Task-handler schema constants
  (`GetTaskRequestSchema` etc.) used as `setRequestHandler` args are **not** rewritten
  — the experimental tasks feature was removed (SEP-2663), so each such registration
  is marked with an action-required diagnostic instead (see
  [Experimental tasks interception removed](references/behavioral-changes.md#experimental-tasks-interception-removed)).
- Renames `ErrorCode` → `ProtocolErrorCode` and routes the local-only members
  (`RequestTimeout`, `ConnectionClosed`) to `SdkErrorCode` — rewriting an all-SDK
  condition's `instanceof ProtocolError` guard to `SdkError`, and marking guards
  that mix the two enums.
- Renames every `StreamableHTTPError` reference to `SdkHttpError` and adds the import
  (constructor calls are marked for review — argument shape changed).
- Replaces `IsomorphicHeaders` with the Web Standard `Headers` type and drops the
  import (a warning notes `Headers` uses `.get()`/`.set()`, not bracket access).
- Rewrites `SchemaInput<T>` → `StandardSchemaWithJSON.InferInput<T>`.
- Renames `RequestHandlerExtra` → `ServerContext` / `ClientContext` and the `extra`
  parameter to `ctx`.
- Rewrites `vi.mock` / `jest.mock` and dynamic `import()` paths.
- Renames the `ResourceTemplate` **type** imported from `@modelcontextprotocol/sdk/types.js`
  to `ResourceTemplateType` (the spec wire type). The `ResourceTemplate` URI-template
  helper **class** from `server/mcp.js` keeps its name and is not renamed.
- Drops `@modelcontextprotocol/sdk/server/zod-compat.js` imports.
- Inverts optional completable nesting — `completable(schema.optional(), cb)` becomes
  `completable(schema, cb).optional()` (see
  [Standard Schema objects](references/server-registration.md#standard-schema-objects-raw-shapes-deprecated)); shapes it
  cannot invert get an `@mcp-codemod-error` marker.
- Rewrites `Protocol` / `mergeCapabilities` imports from `shared/protocol.js` to the
  client or server package root, like the module's other symbols.

## What the codemod does NOT handle

Each of these maps to a manual section below. The codemod marks every site it
recognized but could not safely rewrite with an `@mcp-codemod-error` comment.

- **Node 20 / ESM** — pre-flight, not a code rewrite. → [Packaging & runtime](references/packaging-runtime.md#packaging--runtime)
- **Header-read `.get()` rewrite** — `IsomorphicHeaders` is renamed to `Headers`
  and `extra.requestInfo?.headers[…]` is remapped to `ctx.http?.req?.headers[…]`, but
  converting that bracket access to `.get()` is manual. (Headers you _pass in_ via
  `requestInit.headers` need no rewrite — plain objects remain valid.)
  → [HTTP & headers](references/http-headers.md#http--headers)
- **`ctx.mcpReq.send()` schema-arg drop** — the codemod drops the schema arg from
  `client.request()` / `client.callTool()` but leaves nested `ctx.mcpReq.send()` calls
  alone. → [Low-level protocol](references/protocol-ctx.md#low-level-protocol--handler-context-ctx)
- **OAuth error-class consolidation** — `instanceof InvalidGrantError` → `OAuthError` +
  `OAuthErrorCode` is a judgment rewrite. → [Auth](references/auth.md#auth)
- **`SdkErrorCode` branch selection** — the codemod renames `StreamableHTTPError` →
  `SdkHttpError`; deciding which `SdkErrorCode` branch a given catch should match is
  judgment. → [Errors](references/errors.md#errors)
- **Namespace schema access** — `import * as t from '…/types.js'` +
  `t.CallToolResultSchema.parse(…)` can't be split per-symbol; the codemod flags it
  action-required — re-import the schema from `@modelcontextprotocol/core` by hand.
  → [Types & schemas](references/types-schemas.md#types--schemas)
- **Import-less (injected) SDK surfaces** — the codemod is import-driven: a file that
  receives the SDK surface as a parameter (dependency injection, factory seams) and has
  no SDK import is never rewritten, and the v1 idioms there fail at **runtime**, not
  compile time — e.g. the v1 schema-first `setRequestHandler(Schema, …)` form throws a
  `TypeError` at registration. Grep such seams for v1 API tokens beyond import
  statements (`setRequestHandler(`, `ErrorCode.`, `extra.`) and apply the
  [handler-registration](references/protocol-ctx.md#setrequesthandler--setnotificationhandler-use-method-strings)
  and [Errors](references/errors.md#errors) sections by hand.
  → [Low-level protocol](references/protocol-ctx.md#low-level-protocol--handler-context-ctx)
- **Behavioral adaptation** — list auto-aggregation, capability empties, lazy validator
  compilation, output-schema validation rules. → [Behavioral changes](references/behavioral-changes.md#behavioral-changes)

---

## Manual changes (what the codemod does not handle)

<!-- #endregion codemod -->

Each subsystem has its own reference file. Open the one that matches the type error, runtime failure or `@mcp-codemod-error` marker in front of you; most migrations need only a few of them.

| Reference file                                                             | Read it when                                                                                                                                                                                   |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Packaging & runtime](references/packaging-runtime.md)                     | Choosing which v2 packages to install, or dealing with Node/ESM/CommonJS setup, monorepo workspaces, Jest, nested `zod` copies, migrating in stages, or a library that peer-depends on the SDK |
| [Imports & transports](references/imports-transports.md)                   | A transport import needs a runtime decision (Node vs web-standard Streamable HTTP) or a stdio import moved to a `./stdio` subpath                                                              |
| [Low-level protocol & handler context (`ctx`)](references/protocol-ctx.md) | Code uses `extra` / `ctx`, `setRequestHandler` / `setNotificationHandler`, `request()`, `ctx.mcpReq.send()` or `callTool()`                                                                    |
| [Server registration API](references/server-registration.md)               | Code registers tools, prompts or resources, or passes raw Zod shapes as schemas                                                                                                                |
| [HTTP & headers](references/http-headers.md)                               | Code reads HTTP request headers                                                                                                                                                                |
| [Errors](references/errors.md)                                             | Code throws or catches `McpError` / `ProtocolError`, `ErrorCode`, `SdkError` or `SdkHttpError`                                                                                                 |
| [Auth](references/auth.md)                                                 | Code uses OAuth (`auth()`, `OAuthClientProvider`, OAuth error classes) or bearer-token auth                                                                                                    |
| [Types & schemas](references/types-schemas.md)                             | Code imports Zod `*Schema` constants or removed type aliases, or depends on JSON Schema details                                                                                                |
| [Behavioral changes](references/behavioral-changes.md)                     | The code compiles but tests or runtime behavior differ                                                                                                                                         |
| [Enhancements](references/enhancements.md)                                 | Optional: v2 features worth adopting once the upgrade is done                                                                                                                                  |
| [Unchanged APIs](references/unchanged-apis.md)                             | Checking whether an API changed at all before rewriting it                                                                                                                                     |

<!-- #region need-help -->

## Need help?

- The codemod's [`@mcp-codemod-error`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/codemod/README.md) markers point
  at every site it could not safely rewrite.
- The [Troubleshooting](https://ts.sdk.modelcontextprotocol.io/v2/troubleshooting.md) page covers common errors and their fixes.
- Runnable [examples](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples)
  for every subsystem.
- Open an issue on [GitHub](https://github.com/modelcontextprotocol/typescript-sdk/issues).

<!-- #endregion need-help -->
