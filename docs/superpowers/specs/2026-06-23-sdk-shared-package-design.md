# Design: `@modelcontextprotocol/sdk-shared` — canonical Zod schemas package

- **Date:** 2026-06-23
- **Status:** Approved (design); implementation plan pending
- **Owner:** Konstantin Konstantinov

## Problem

The v1→v2 migration of runtime schema validation is non-mechanical and lossy.

In v1, consumers validated values with the exported Zod schema constants:

```ts
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';

const parsed = ListToolsResultSchema.parse(res.body.result);   // throws on invalid, returns value
const r = CallToolResultSchema.safeParse(value);                // { success, data, error }
```

In v2 these schemas are reached via `specTypeSchemas.X` and **typed** as `StandardSchemaV1` (to keep Zod out of the public API), even though **at runtime they are still the underlying Zod schemas**. Because the public type is Standard Schema, `.parse()`/`.safeParse()` are not visible to the type checker, so the current codemod:

- rewrites `CallToolResultSchema` → `specTypeSchemas.CallToolResult`,
- converts `.safeParse(x)` → `specTypeSchemas.X['~standard'].validate(x)` and remaps `.success`/`.data`/`.error` (which also changes the thrown error type), and
- has **no** one-line equivalent for `.parse()` (it throws; `validate()` does not), so those sites get a manual-migration diagnostic and don't compile until hand-edited.

Validated against `firebase/firebase-tools`, this produced 4 post-codemod typecheck errors (all `.parse()`), plus project-type-resolution warnings on type-only files.

A prior attempt (PR #2277) surfaces `parse()`/`safeParse()` on each `specTypeSchemas.X` entry as **type-only** methods and migrates by reference rename. That works but (a) pollutes the deliberately library-agnostic Standard Schema type with Zod-specific methods, and (b) only covers `parse`/`safeParse`, not other Zod methods (`.extend()`, `.merge()`, `.shape`, …).

## Goals

- Make schema-validation migration a **mechanical, behavior-preserving import-path swap**: `.parse()`/`.safeParse()` and every other Zod method keep working unchanged.
- Keep the `server`/`client` main API surface **Zod-free**; Zod coupling is opt-in and explicit.
- Establish a **canonical home for shared spec primitives** (schemas + types now, room for more later).
- Keep `specTypeSchemas`/`isSpecType` (the Standard Schema, library-agnostic view) intact and recommended for library-agnostic validation.

## Non-goals

- Changing the Standard Schema typing of `specTypeSchemas` (we are **not** adding `parse`/`safeParse` to it — this supersedes PR #2277's approach).
- Moving `Protocol`, transports, or validators. They stay in `core` and follow existing migration rules.
- Moving `specTypeSchemas`/`isSpecType` out of `core/public` (possible later; out of scope now).

> **Update during implementation (Option C, user-approved):** the protocol **enums** (`enums.ts` →
> `ProtocolErrorCode`), **error classes** (`errors.ts` → `ProtocolError`, …), and **type guards**
> (`guards.ts`) were *also* moved into `sdk-shared`, reversing the original "they stay in core"
> non-goal. Rationale: v1's `sdk/types.js` was a kitchen-sink exporting all of these alongside the
> spec types/schemas, so the codemod's `types.js → sdk-shared` routing is only correct if sdk-shared
> carries that whole surface. Their dependency closure (schemas/types/enums) is already in sdk-shared,
> so the move is clean and introduces no cycle. **Exception:** `SdkError`/`SdkErrorCode`/`SdkHttpError`
> (the SDK-side error split, in `core/errors/sdkErrors.ts`) deliberately stay in `core` → `server`/`client`.

## Decisions (locked)

| Decision | Choice |
| --- | --- |
| Package name | `@modelcontextprotocol/sdk-shared` |
| Scope of move | Spec **types + Zod `*Schema` constants** |
| Positioning | Zod schemas are **first-class** (no codemod nudge toward `specTypeSchemas`) |
| server/client bundling | Depend on `sdk-shared` as a **regular dependency**, marked **external** (not bundled) |
| server/client re-exports | Re-export **types** from `sdk-shared`; do **not** re-export the raw Zod `*Schema` constants |
| Consumer dependency | Regular `dependency` (not peer); codemod adds it |
| core churn control | `core`'s internal barrel **re-exports** schemas/types from `sdk-shared` |

## Architecture

### Package

New public package `packages/sdk-shared/` (`@modelcontextprotocol/sdk-shared`):

- Owns the canonical MCP spec data model: the Zod `*Schema` constants and their derived TS types (`Tool`, `CallToolResult`, …), extracted from `packages/core/src/types/types.ts`.
- Depends only on `zod` (catalog: `runtimeShared`). **Runtime-neutral** — no Node builtins — so browser/Cloudflare Workers bundlers can consume it (covered by a `barrelClean` test, per CLAUDE.md).
- Uses explicit named exports.

### Dependency graph (new edges in **bold**)

```
zod
 └── @modelcontextprotocol/sdk-shared      (NEW — types + Zod *Schema constants; zod-only)
      ├── @modelcontextprotocol/core        (private; imports schemas/types from sdk-shared, re-exports them from its barrel)
      ├── **@modelcontextprotocol/server**  ─┐ regular dependency,
      └── **@modelcontextprotocol/client**  ─┘ marked EXTERNAL in tsdown (not bundled)
```

`server`/`client` today inline `core` (and thus the schemas). After this change they treat `@modelcontextprotocol/sdk-shared` as an external dependency, so there is a single runtime instance and their bundles shrink. (Instance identity is not a correctness concern — validation is structural — so "single instance" is about source-of-truth and bundle size, not behavior.)

### What moves vs. stays

- **Moves to `sdk-shared`:** the spec Zod `*Schema` constants and their inferred TS types. `types.ts` is **split** along this line; the exact boundary (pure spec schemas + inferred types move; protocol constants such as `LATEST_PROTOCOL_VERSION` and method-name constants stay in `core` for now) is finalized during implementation. `core`'s barrel keeps re-exporting the moved symbols so the ~hundreds of internal `core` imports don't all change.
- **Stays in `core`:** `Protocol`, transports, validators, error classes/enums, protocol constants, and `specTypeSchemas`/`isSpecType` (rebuilt from `sdk-shared`'s schemas, exported via `core/public` as today).

### Public API surface after the change

| Symbol kind | Canonical home | Also re-exported by | Typed as |
| --- | --- | --- | --- |
| Spec **types** (`Tool`, `CallToolResult`, …) | `sdk-shared` | `core/public`, `server`, `client` | TS types (Zod-free) |
| Zod **`*Schema` constants** | `sdk-shared` **only** | — (intentionally not on server/client) | real Zod schemas |
| `specTypeSchemas` / `isSpecType` | `core/public` | `server`, `client` | `StandardSchemaV1` (Zod-free) |

Guidance: use `specTypeSchemas` for library-agnostic Standard Schema validation; import the Zod `*Schema` from `@modelcontextprotocol/sdk-shared` when you want Zod ergonomics (`.parse`, `.safeParse`, `.extend`, …) or are migrating v1 code.

## Codemod changes

Today: the `imports` transform sends `sdk/types.js` → `RESOLVE_BY_CONTEXT`; the `specSchemaAccess` transform rewrites the schema reference, converts `.safeParse()`, and emits a manual-migration diagnostic for `.parse()`.

After:

1. **`@modelcontextprotocol/sdk/types.js`** (and the extensionless `/types`, already handled) **→ `@modelcontextprotocol/sdk-shared`**: a fixed, context-free path swap covering both types and `*Schema` constants. Symbol names unchanged; existing `renamedSymbols` (e.g. `ResourceTemplate`→`ResourceTemplateType`) still apply.
2. **Retire `specSchemaAccess`'s schema rewriting.** Because `sdk-shared` exports real Zod schemas, `.parse()`/`.safeParse()`/`.extend()`/`.shape`/… all keep working untouched — no reference rename, no `.safeParse` result remap, no `.parse()` manual-migration diagnostic. The independent `schemaParamRemoval` transform (strips schema args from `request()`/`callTool()`) is unaffected and stays.
3. **`updatePackageJson` adds `@modelcontextprotocol/sdk-shared`** to the consumer whenever a `types.js` import is routed there.

Expected effect on `firebase/firebase-tools`: the 4 `.parse()` errors disappear (schemas validate via Zod as before) and the project-type warnings on type-only files disappear (fixed target, no context resolution) → **zero codemod-introduced typecheck errors**, far fewer diagnostics.

## Testing strategy

- **`sdk-shared` package:** unit tests asserting expected exports exist; `barrelClean` test (no Node builtins); runtime-neutral.
- **`codemod`:** update `importPaths` tests (`types.js`/`/types` → `sdk-shared`); remove/trim `specSchemaAccess` tests; add coverage for the dependency addition and "schema usage passes through untouched."
- **`core`/`server`/`client`:** existing suites + typecheck stay green after the `types.ts` split (the main risk).
- **Batch test:** add `sdk-shared` to `LOCAL_PACKAGE_DIRS`; add an `overrides` entry so the transitive `server`→`sdk-shared` edge resolves to the local tarball; re-run `firebase/firebase-tools` and confirm 0 introduced typecheck errors.

## Docs & rollout

- Rewrite the spec-schema validation section in `docs/migration.md` and `docs/migration-SKILL.md`: schemas now import from `@modelcontextprotocol/sdk-shared`, `.parse`/`.safeParse` keep working; `specTypeSchemas` remains for library-agnostic validation. Document the new package.
- Add a changeset covering the new package and the codemod change.
- **PR #2277 coordination:** this **supersedes** #2277's `specTypeSchemas` type-only `parse`/`safeParse` approach. Its other improvements are independent and worth keeping: client/server inference (#2) and the `tasks/*` handler-map fix (#3). The extensionless-import fix (#4) is already implemented on this branch.

## Risks & mitigations

- **Splitting `types.ts`** is wide-reaching. Mitigation: keep `core`'s barrel re-exporting the moved symbols; land the move as its own step with full `core` typecheck/tests green before touching the codemod.
- **Transitive local-tarball resolution** in the batch test (`server`→`sdk-shared`). Mitigation: `overrides` entry pointing `sdk-shared` at the local tarball (or publish an alpha).
- **New publish/version target.** Mitigation: version `sdk-shared` in lockstep with the other v2 packages via changesets.

## Open questions (non-blocking)

- Final split boundary inside `types.ts` (which non-schema symbols, if any, also belong in `sdk-shared`).
- Whether `specTypeSchemas`/`isSpecType` should eventually move to `sdk-shared` too (deferred).
