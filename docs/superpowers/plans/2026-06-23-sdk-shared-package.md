# `@modelcontextprotocol/sdk-shared` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the canonical MCP spec data model (Zod schemas + derived TS types + protocol constants) into a new publishable package `@modelcontextprotocol/sdk-shared`, so v1→v2 schema-validation migration becomes a mechanical import-path swap with `.parse`/`.safeParse`/all Zod methods preserved.

**Architecture:** A new zod-only, runtime-neutral package owns `constants.ts` + `schemas.ts` + `types.ts` (moved from `core`). `core` keeps thin re-export shims at the old paths (churn control); `core/public`, `server`, and `client` re-export the **types** (Zod-free) and continue to expose `specTypeSchemas` unchanged; the raw Zod `*Schema` constants are reachable only from `sdk-shared`. The codemod routes `@modelcontextprotocol/sdk/types.js` → `@modelcontextprotocol/sdk-shared` as a fixed path swap and drops the `specSchemaAccess` rewriting entirely.

**Tech Stack:** TypeScript (NodeNext, `tsgo` typecheck), Zod v4, tsdown (build, ESM `.mjs`/`.d.mts`), vitest, ts-morph (codemod), changesets (prerelease `alpha` mode), pnpm workspaces.

## Global Constraints

- Node engine floor: `>=20`. Package version line: `2.0.0-alpha.2` (match other runtime packages).
- Formatting (Prettier, `.prettierrc.json`): 4-space indent, single quotes, semicolons, **no trailing commas**, print width 140. All new/edited files must satisfy `prettier --check`.
- Source imports use explicit `.js` extensions (NodeNext); sibling `.ts` files import each other as `./x.js`.
- Public API uses **explicit named exports** except `types.ts`, which is the one intentional `export *` (it contains only spec-derived TS types).
- `sdk-shared` must be **runtime-neutral** (no Node builtins) — guarded by a `barrelClean` test.
- `sdk-shared`'s only runtime dependency is `zod` (`catalog:runtimeShared` → `^4.2.0`). No `publishConfig` (root `.npmrc` + changesets `access: public` handle it).
- Never run `git add`/`git commit` (a hook blocks it). At each "Commit" step, **print the suggested commands** for the user to run manually.
- Typecheck per package: `tsgo -p tsconfig.json --noEmit`. Tests: `vitest run` (tests live in `test/**/*.test.ts`, not colocated).

---

## File Structure

**New package `packages/sdk-shared/`:**
- `package.json`, `tsconfig.json`, `tsdown.config.ts`, `vitest.config.js`, `eslint.config.mjs`, `README.md`
- `src/constants.ts`, `src/schemas.ts`, `src/types.ts` — relocated from `packages/core/src/types/`
- `src/index.ts` — main barrel: types + constants + schemas (everything; first-class Zod)
- `test/barrelClean.test.ts` — runtime-neutrality guard
- The `./types` subpath is served directly by the built `src/types.ts` (types-only; Zod-free) for `core/public` to re-export.

**Modified in `packages/core/`:**
- `src/types/constants.ts`, `src/types/schemas.ts`, `src/types/types.ts` → become 1-line re-export shims pointing at `sdk-shared` (churn control)
- `src/exports/public/index.ts` → re-point the types `export *` and the constants named-export at `sdk-shared`
- `package.json` → add `@modelcontextprotocol/sdk-shared` dependency
- `src/types/specTypeSchema.ts` → its `import * as schemas from './schemas.js'` keeps working via the shim (no edit needed if shim is in place)

**Modified in `packages/server/`, `packages/client/`:**
- `package.json` → add `@modelcontextprotocol/sdk-shared` dependency
- `tsdown.config.ts` → add `@modelcontextprotocol/sdk-shared` to `external`; add its `src` path to the dts `paths` so `.d.mts` resolves

**Modified in `packages/codemod/`:**
- `scripts/generateVersions.ts` → add `sdk-shared` to `PACKAGE_DIRS`; regenerate `src/generated/versions.ts`
- `src/migrations/v1-to-v2/mappings/importMap.ts` → `sdk/types.js` target becomes `@modelcontextprotocol/sdk-shared`
- `src/migrations/v1-to-v2/transforms/index.ts` → remove `specSchemaAccess` from the pipeline
- delete `src/migrations/v1-to-v2/transforms/specSchemaAccess.ts` + `test/v1-to-v2/transforms/specSchemaAccess.test.ts`
- update `test/v1-to-v2/transforms/importPaths.test.ts` and any integration test expecting `specTypeSchemas` output
- `src/bin/batchTest.ts` → add `sdk-shared` to `LOCAL_PACKAGE_DIRS`; add `overrides` so transitive `server→sdk-shared` resolves to the local tarball

**Modified docs / release:**
- `docs/migration.md`, `docs/migration-SKILL.md` → rewrite spec-schema validation section
- `.changeset/pre.json` → add `sdk-shared` to `initialVersions`; new `.changeset/add-sdk-shared-package.md`

---

## Phase 1 — Create `sdk-shared`, move the spec data model, rewire consumers

### Task 1.1: Scaffold the empty `sdk-shared` package

**Files:**
- Create: `packages/sdk-shared/package.json`, `tsconfig.json`, `tsdown.config.ts`, `vitest.config.js`, `eslint.config.mjs`, `README.md`, `src/index.ts`
- Modify: `.changeset/pre.json`
- Create: `.changeset/add-sdk-shared-package.md`

**Interfaces:**
- Produces: a buildable workspace package `@modelcontextprotocol/sdk-shared` whose `dist/index.mjs` + `dist/index.d.mts` exist. No real exports yet (placeholder).

- [ ] **Step 1: Create `packages/sdk-shared/package.json`**

```json
{
    "name": "@modelcontextprotocol/sdk-shared",
    "private": false,
    "version": "2.0.0-alpha.2",
    "description": "Shared types and Zod schemas for the Model Context Protocol TypeScript SDK",
    "license": "MIT",
    "author": "Anthropic, PBC (https://anthropic.com)",
    "homepage": "https://modelcontextprotocol.io",
    "bugs": "https://github.com/modelcontextprotocol/typescript-sdk/issues",
    "type": "module",
    "repository": {
        "type": "git",
        "url": "git+https://github.com/modelcontextprotocol/typescript-sdk.git"
    },
    "engines": {
        "node": ">=20"
    },
    "keywords": ["modelcontextprotocol", "mcp", "schemas", "types"],
    "exports": {
        ".": {
            "types": "./dist/index.d.mts",
            "import": "./dist/index.mjs"
        },
        "./types": {
            "types": "./dist/types.d.mts",
            "import": "./dist/types.mjs"
        }
    },
    "types": "./dist/index.d.mts",
    "typesVersions": {
        "*": {
            "types": ["dist/types.d.mts"]
        }
    },
    "files": ["dist"],
    "scripts": {
        "typecheck": "tsgo -p tsconfig.json --noEmit",
        "build": "tsdown",
        "build:watch": "tsdown --watch",
        "prepack": "pnpm run build",
        "lint": "eslint src/ && prettier --ignore-path ../../.prettierignore --check .",
        "lint:fix": "eslint src/ --fix && prettier --ignore-path ../../.prettierignore --write .",
        "check": "pnpm run typecheck && pnpm run lint",
        "test": "vitest run",
        "test:watch": "vitest"
    },
    "dependencies": {
        "zod": "catalog:runtimeShared"
    },
    "devDependencies": {
        "@modelcontextprotocol/eslint-config": "workspace:^",
        "@modelcontextprotocol/tsconfig": "workspace:^",
        "@modelcontextprotocol/vitest-config": "workspace:^",
        "@eslint/js": "catalog:devTools",
        "@typescript/native-preview": "catalog:devTools",
        "eslint": "catalog:devTools",
        "eslint-config-prettier": "catalog:devTools",
        "eslint-plugin-n": "catalog:devTools",
        "prettier": "catalog:devTools",
        "tsdown": "catalog:devTools",
        "typescript": "catalog:devTools",
        "typescript-eslint": "catalog:devTools",
        "vitest": "catalog:devTools"
    }
}
```

- [ ] **Step 2: Create `packages/sdk-shared/tsconfig.json`**

```json
{
    "extends": "@modelcontextprotocol/tsconfig",
    "include": ["./"],
    "exclude": ["node_modules", "dist"],
    "compilerOptions": {
        "paths": { "*": ["./*"] }
    }
}
```

- [ ] **Step 3: Create `packages/sdk-shared/tsdown.config.ts`** (two entries: main + the types-only subpath)

```ts
import { defineConfig } from 'tsdown';

export default defineConfig({
    failOnWarn: 'ci-only',
    entry: ['src/index.ts', 'src/types.ts'],
    format: ['esm'],
    outDir: 'dist',
    clean: true,
    sourcemap: true,
    target: 'esnext',
    platform: 'node',
    shims: true,
    dts: { resolver: 'tsc' }
});
```

- [ ] **Step 4: Create `packages/sdk-shared/vitest.config.js`**

```js
import baseConfig from '@modelcontextprotocol/vitest-config';

export default baseConfig;
```

- [ ] **Step 5: Create `packages/sdk-shared/eslint.config.mjs`**

```js
// @ts-check

import baseConfig from '@modelcontextprotocol/eslint-config';

export default [
    ...baseConfig,
    {
        settings: {
            'import/internal-regex': '^@modelcontextprotocol/sdk-shared'
        }
    }
];
```

- [ ] **Step 6: Create `packages/sdk-shared/README.md`**

```md
# @modelcontextprotocol/sdk-shared

Shared types and Zod schemas for the Model Context Protocol TypeScript SDK. Exposes the canonical MCP spec data model: the Zod `*Schema` constants, their derived TypeScript types, and protocol constants.

- Import types and Zod schemas from `@modelcontextprotocol/sdk-shared`.
- For library-agnostic (Standard Schema) validation, prefer `specTypeSchemas` from `@modelcontextprotocol/server` / `@modelcontextprotocol/client`.
```

- [ ] **Step 7: Create placeholder `packages/sdk-shared/src/index.ts`**

```ts
// Placeholder — real exports added in Task 1.2.
export const SDK_SHARED_PLACEHOLDER = true;
```

- [ ] **Step 8: Register the package in changesets prerelease state** — edit `.changeset/pre.json`, adding this entry to the `initialVersions` object (alphabetical position is fine):

```json
"@modelcontextprotocol/sdk-shared": "2.0.0-alpha.0"
```

- [ ] **Step 9: Create `.changeset/add-sdk-shared-package.md`**

```md
---
'@modelcontextprotocol/sdk-shared': minor
---

Add @modelcontextprotocol/sdk-shared package: the canonical home for MCP spec Zod schemas, their derived TypeScript types, and protocol constants.
```

- [ ] **Step 10: Install + build to verify the scaffold**

Run: `pnpm install && pnpm --filter @modelcontextprotocol/sdk-shared build`
Expected: install succeeds; build writes `packages/sdk-shared/dist/index.mjs` and `dist/index.d.mts` (and `dist/types.*`). Verify: `ls packages/sdk-shared/dist` shows `index.mjs index.d.mts types.mjs types.d.mts`.

- [ ] **Step 11: Commit** (print for the user)

```bash
git add packages/sdk-shared .changeset/pre.json .changeset/add-sdk-shared-package.md
git commit -m "feat(sdk-shared): scaffold empty @modelcontextprotocol/sdk-shared package"
```

---

### Task 1.2: Relocate the spec data model into `sdk-shared`

**Files:**
- Move: `packages/core/src/types/constants.ts` → `packages/sdk-shared/src/constants.ts`
- Move: `packages/core/src/types/schemas.ts` → `packages/sdk-shared/src/schemas.ts`
- Move: `packages/core/src/types/types.ts` → `packages/sdk-shared/src/types.ts`
- Modify: `packages/sdk-shared/src/index.ts`

**Interfaces:**
- Produces: `@modelcontextprotocol/sdk-shared` exports all spec types + all `*Schema` Zod constants + all protocol constants from `.`; `@modelcontextprotocol/sdk-shared/types` exports the spec **types only**.
- Consumes: nothing new (the three files are self-contained — only external import is `zod/v4`).

- [ ] **Step 1: Move the three files** (preserves content + history)

```bash
git mv packages/core/src/types/constants.ts packages/sdk-shared/src/constants.ts
git mv packages/core/src/types/schemas.ts packages/sdk-shared/src/schemas.ts
git mv packages/core/src/types/types.ts packages/sdk-shared/src/types.ts
```

The internal relative imports between these three files (`./constants.js`, `./types.js`, `./schemas.js`) and `zod/v4` remain valid in the new location — no edits needed inside them. Remove the `⚠️ PUBLIC API` comment header in `types.ts` that references `exports/public/index.ts` only if it is now inaccurate; otherwise leave it.

- [ ] **Step 2: Write the real `packages/sdk-shared/src/index.ts`** (replace the placeholder)

```ts
// Canonical MCP spec data model: protocol constants, spec-derived TS types, and the
// Zod *Schema constants. The `.` entry is the first-class public surface (Zod included).
// The types-only `./types` subpath is served by ./types.ts directly (see package.json exports).
export * from './constants.js';
export * from './types.js';
export * from './schemas.js';
```

- [ ] **Step 3: Typecheck `sdk-shared` in isolation**

Run: `pnpm --filter @modelcontextprotocol/sdk-shared typecheck`
Expected: PASS (no errors). If `tsgo` reports a missing import, it means a fourth file was part of the closure — re-check `schemas.ts`/`types.ts`/`constants.ts` imports and move any additional self-contained spec file.

- [ ] **Step 4: Build `sdk-shared`**

Run: `pnpm --filter @modelcontextprotocol/sdk-shared build`
Expected: PASS; `dist/index.mjs` now contains the schema runtime values; `dist/types.d.mts` exposes the 178 types.

- [ ] **Step 5: Commit** (print for the user)

```bash
git add packages/sdk-shared packages/core/src/types
git commit -m "feat(sdk-shared): move spec constants, schemas, and types into sdk-shared"
```

---

### Task 1.3: Rewire `core` to consume `sdk-shared` via re-export shims

**Files:**
- Create (at the old paths): `packages/core/src/types/constants.ts`, `packages/core/src/types/schemas.ts`, `packages/core/src/types/types.ts` — now 1-line re-export shims
- Modify: `packages/core/package.json` (add dependency)
- Modify: `packages/core/src/exports/public/index.ts` (re-point types `export *`)
- Modify: `packages/core/tsconfig.json` (path mapping for `tsgo`, if needed)

**Interfaces:**
- Consumes: `@modelcontextprotocol/sdk-shared` (`.` and `./types`).
- Produces: `core`'s internal relative imports of `./types.js`/`./schemas.js`/`./constants.js` keep resolving (via shims); `core/public` exports the same public symbols as before (types via `sdk-shared/types`, constants via `sdk-shared`, no schema values), so `server`/`client` surfaces are unchanged and Zod-free.

- [ ] **Step 1: Add the dependency to `packages/core/package.json`** — add to `dependencies`:

```json
"@modelcontextprotocol/sdk-shared": "workspace:^"
```

- [ ] **Step 2: Create the re-export shims at the old core paths.** `packages/core/src/types/constants.ts`:

```ts
// Moved to @modelcontextprotocol/sdk-shared. Re-exported here so core's internal
// relative imports (./constants.js) keep resolving without a wide rename.
export * from '@modelcontextprotocol/sdk-shared';
```

`packages/core/src/types/schemas.ts`:

```ts
// Moved to @modelcontextprotocol/sdk-shared.
export * from '@modelcontextprotocol/sdk-shared';
```

`packages/core/src/types/types.ts`:

```ts
// Moved to @modelcontextprotocol/sdk-shared (types-only subpath keeps this Zod-free).
export * from '@modelcontextprotocol/sdk-shared/types';
```

(The `schemas.ts` shim re-exports the full surface so `import * as schemas from './schemas.js'` in `specTypeSchema.ts` still finds every `*Schema` value. The `types.ts` shim uses the types-only subpath so anything `export *`-ing it stays Zod-free.)

- [ ] **Step 3: Re-point the types `export *` in `packages/core/src/exports/public/index.ts`.** The line currently reads `export * from '../../types/types.js';`. It can stay as-is (the shim now forwards to `sdk-shared/types`). **Verify** the constants named-export block (`export { BAGGAGE_META_KEY, … } from '../../types/constants.js';`) still resolves through the `constants.ts` shim. No code change required if shims are in place — confirm in Step 5.

- [ ] **Step 4: Update `core`'s tsgo path mapping if needed.** If Step 5 typecheck fails to resolve `@modelcontextprotocol/sdk-shared`, add to `packages/core/tsconfig.json` `compilerOptions.paths`:

```json
"@modelcontextprotocol/sdk-shared": ["./node_modules/@modelcontextprotocol/sdk-shared/src/index.ts"],
"@modelcontextprotocol/sdk-shared/types": ["./node_modules/@modelcontextprotocol/sdk-shared/src/types.ts"]
```

- [ ] **Step 5: Reinstall, typecheck, and test core**

Run: `pnpm install && pnpm --filter @modelcontextprotocol/core typecheck && pnpm --filter @modelcontextprotocol/core test`
Expected: typecheck PASS; all core tests PASS. The key assertion: `specTypeSchemas` still builds (it reads schema values through the `schemas.ts` shim).

- [ ] **Step 6: Commit** (print for the user)

```bash
git add packages/core
git commit -m "refactor(core): consume sdk-shared via re-export shims; keep public surface unchanged"
```

---

### Task 1.4: Wire `server` and `client` to depend on `sdk-shared` (external, not bundled)

**Files:**
- Modify: `packages/server/package.json`, `packages/client/package.json` (add dependency)
- Modify: `packages/server/tsdown.config.ts`, `packages/client/tsdown.config.ts` (external + dts paths)
- Modify: `packages/server/tsconfig.json`, `packages/client/tsconfig.json` (tsgo path mapping)

**Interfaces:**
- Consumes: `@modelcontextprotocol/sdk-shared` at runtime (external dependency).
- Produces: `server`/`client` `dist` no longer inlines the schema/type source; their root barrels still re-export the spec **types** and `specTypeSchemas` (Zod-free); `barrelClean` still passes.

- [ ] **Step 1: Add the dependency** to both `packages/server/package.json` and `packages/client/package.json` `dependencies`:

```json
"@modelcontextprotocol/sdk-shared": "workspace:^"
```

- [ ] **Step 2: Mark it external in `packages/server/tsdown.config.ts`.** Add `'@modelcontextprotocol/sdk-shared'` to the `external` array (create the array if absent — server already has `external: ['@modelcontextprotocol/server/_shims']`):

```ts
    external: ['@modelcontextprotocol/server/_shims', '@modelcontextprotocol/sdk-shared'],
```

Add its source path to the dts `compilerOptions.paths` block so `.d.mts` generation resolves the external types:

```ts
                '@modelcontextprotocol/sdk-shared': ['../sdk-shared/src/index.ts'],
                '@modelcontextprotocol/sdk-shared/types': ['../sdk-shared/src/types.ts'],
```

- [ ] **Step 3: Do the same in `packages/client/tsdown.config.ts`** (add `'@modelcontextprotocol/sdk-shared'` to `external`, and the two `paths` entries to the dts block).

- [ ] **Step 4: Add tsgo path mapping** to `packages/server/tsconfig.json` and `packages/client/tsconfig.json` `compilerOptions.paths` (mirroring how they map `@modelcontextprotocol/core`):

```json
"@modelcontextprotocol/sdk-shared": ["./node_modules/@modelcontextprotocol/sdk-shared/src/index.ts"],
"@modelcontextprotocol/sdk-shared/types": ["./node_modules/@modelcontextprotocol/sdk-shared/src/types.ts"]
```

- [ ] **Step 5: Reinstall, build, typecheck, test both packages**

Run: `pnpm install && pnpm --filter @modelcontextprotocol/server --filter @modelcontextprotocol/client build && pnpm --filter @modelcontextprotocol/server --filter @modelcontextprotocol/client typecheck && pnpm --filter @modelcontextprotocol/server --filter @modelcontextprotocol/client test`
Expected: all PASS, including `barrelClean.test.ts`.

- [ ] **Step 6: Verify `sdk-shared` is external in the build output** (not inlined)

Run: `grep -c "@modelcontextprotocol/sdk-shared" packages/server/dist/index.mjs`
Expected: ≥ 1 (an `import ... from "@modelcontextprotocol/sdk-shared..."` line — proving it's referenced as an external dependency, not bundled). And the spec schema source is NOT inlined: `grep -c "z.object" packages/server/dist/index.mjs` should be markedly lower than before the change (spot-check; not a hard gate).

- [ ] **Step 7: Full repo gate**

Run: `pnpm typecheck:all && pnpm test:all`
Expected: all PASS. This confirms the move didn't break any sibling package.

- [ ] **Step 8: Commit** (print for the user)

```bash
git add packages/server packages/client
git commit -m "refactor(server,client): depend on sdk-shared as an external dependency"
```

---

## Phase 2 — Codemod: route `types.js` → `sdk-shared`, drop `specSchemaAccess`

### Task 2.1: Register `sdk-shared` in the codemod version map

**Files:**
- Modify: `packages/codemod/scripts/generateVersions.ts`
- Regenerate: `packages/codemod/src/generated/versions.ts`

**Interfaces:**
- Produces: `V2_PACKAGE_VERSIONS` includes `@modelcontextprotocol/sdk-shared`, so `updatePackageJson` is allowed to add it to a consumer's deps.

- [ ] **Step 1: Add `sdk-shared` to `PACKAGE_DIRS`** in `packages/codemod/scripts/generateVersions.ts`:

```ts
const PACKAGE_DIRS: Record<string, string> = {
    '@modelcontextprotocol/client': 'client',
    '@modelcontextprotocol/server': 'server',
    '@modelcontextprotocol/node': 'middleware/node',
    '@modelcontextprotocol/express': 'middleware/express',
    '@modelcontextprotocol/server-legacy': 'server-legacy',
    '@modelcontextprotocol/sdk-shared': 'sdk-shared'
};
```

- [ ] **Step 2: Regenerate**

Run: `pnpm --filter @modelcontextprotocol/codemod generate:versions`
Expected: `src/generated/versions.ts` now contains `'@modelcontextprotocol/sdk-shared': '^2.0.0-alpha.2'`. Verify: `grep sdk-shared packages/codemod/src/generated/versions.ts`.

- [ ] **Step 3: Commit** (print for the user)

```bash
git add packages/codemod/scripts/generateVersions.ts packages/codemod/src/generated/versions.ts
git commit -m "feat(codemod): register sdk-shared in V2_PACKAGE_VERSIONS"
```

---

### Task 2.2: Route `sdk/types.js` to `sdk-shared` (TDD)

**Files:**
- Test: `packages/codemod/test/v1-to-v2/transforms/importPaths.test.ts`
- Modify: `packages/codemod/src/migrations/v1-to-v2/mappings/importMap.ts`

**Interfaces:**
- Consumes: `lookupImportMapping` (already extension-tolerant from prior work).
- Produces: any import from `@modelcontextprotocol/sdk/types.js` or `@modelcontextprotocol/sdk/types` is rewritten to `@modelcontextprotocol/sdk-shared` (fixed target, no context resolution), names preserved, and `@modelcontextprotocol/sdk-shared` is added to `usedPackages`.

- [ ] **Step 1: Write the failing test** — add to `importPaths.test.ts` inside the `describe('import-paths transform', …)` block. Also covers that schema-value imports keep their names (no `specTypeSchemas` rewrite):

```ts
it('routes sdk/types.js to @modelcontextprotocol/sdk-shared (types + schemas, fixed target)', () => {
    const input = [
        `import { CallToolResult, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
        ''
    ].join('\n');
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('test.ts', input);
    const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
    const output = sourceFile.getFullText();
    expect(output).toContain(`from "@modelcontextprotocol/sdk-shared"`);
    expect(output).toContain('CallToolResult');
    expect(output).toContain('CallToolResultSchema');
    expect(output).not.toContain('@modelcontextprotocol/sdk/types');
    expect(output).not.toContain('specTypeSchemas');
    expect(result.usedPackages?.has('@modelcontextprotocol/sdk-shared')).toBe(true);
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `pnpm --filter @modelcontextprotocol/codemod test -- importPaths -t "sdk-shared (types + schemas"`
Expected: FAIL — current output routes to `@modelcontextprotocol/server` (RESOLVE_BY_CONTEXT), so the `sdk-shared` assertion fails.

- [ ] **Step 3: Change the `types.js` mapping** in `packages/codemod/src/migrations/v1-to-v2/mappings/importMap.ts`. Replace the existing entry:

```ts
    '@modelcontextprotocol/sdk/types.js': {
        target: '@modelcontextprotocol/sdk-shared',
        status: 'moved',
        renamedSymbols: {
            ResourceTemplate: 'ResourceTemplateType'
        }
    },
```

(Only this entry changes from `RESOLVE_BY_CONTEXT` to the fixed `@modelcontextprotocol/sdk-shared` target. Leave `shared/protocol.js`, `shared/transport.js`, `inMemory.js`, etc. as `RESOLVE_BY_CONTEXT`.)

- [ ] **Step 4: Run the test; verify it passes**

Run: `pnpm --filter @modelcontextprotocol/codemod test -- importPaths -t "sdk-shared (types + schemas"`
Expected: PASS.

- [ ] **Step 5: Update the now-obsolete `types.js` context tests.** The existing tests `resolves sdk/types.js based on sibling client imports`, `resolves sdk/types.js based on sibling server imports`, and the extensionless `resolves extensionless sdk/types …` tests now expect `@modelcontextprotocol/sdk-shared` instead of `@modelcontextprotocol/client`/`/server`. Update each assertion to `expect(result).toContain('@modelcontextprotocol/sdk-shared')` (drop the client/server expectations for the `types`-only cases). Re-run the full file:

Run: `pnpm --filter @modelcontextprotocol/codemod test -- importPaths`
Expected: all PASS.

- [ ] **Step 6: Commit** (print for the user)

```bash
git add packages/codemod/src/migrations/v1-to-v2/mappings/importMap.ts packages/codemod/test/v1-to-v2/transforms/importPaths.test.ts
git commit -m "feat(codemod): route sdk/types.js to @modelcontextprotocol/sdk-shared"
```

---

### Task 2.3: Remove the `specSchemaAccess` transform

**Files:**
- Modify: `packages/codemod/src/migrations/v1-to-v2/transforms/index.ts`
- Delete: `packages/codemod/src/migrations/v1-to-v2/transforms/specSchemaAccess.ts`
- Delete: `packages/codemod/test/v1-to-v2/transforms/specSchemaAccess.test.ts`
- Modify: codemod integration tests that assert `specTypeSchemas` output (e.g. `test/integration.test.ts`)

**Interfaces:**
- Produces: `*Schema` value usages (`.parse`, `.safeParse`, `.extend`, …) pass through untouched — they ride the `types.js → sdk-shared` path swap with names intact.

- [ ] **Step 1: Write a failing pass-through test** in `importPaths.test.ts` (or a new `test/v1-to-v2/passthrough.test.ts` running the full migration) asserting `.parse()` survives. Minimal transform-level version:

```ts
it('leaves *Schema runtime usage (.parse) untouched after routing to sdk-shared', () => {
    const input = [
        `import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
        `const x = CallToolResultSchema.parse(value);`,
        ''
    ].join('\n');
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('test.ts', input);
    importPathsTransform.apply(sourceFile, { projectType: 'server' });
    const output = sourceFile.getFullText();
    expect(output).toContain('CallToolResultSchema.parse(value)');
    expect(output).not.toContain('specTypeSchemas');
    expect(output).not.toContain("['~standard']");
});
```

- [ ] **Step 2: Run it; verify current behavior** — with `specSchemaAccess` still in the pipeline this transform-only test on `importPathsTransform` already passes (specSchemaAccess is a separate transform). To see the regression the removal prevents, run the FULL migration in this test instead by importing and applying every transform in order. Confirm that BEFORE removal the full-migration output contains `specTypeSchemas` (FAIL of the `not.toContain` assertion), proving `specSchemaAccess` is what rewrites it.

Run: `pnpm --filter @modelcontextprotocol/codemod test -- passthrough`
Expected: FAIL on `not.toContain('specTypeSchemas')` (full-migration variant).

- [ ] **Step 3: Remove `specSchemaAccess` from the pipeline** in `packages/codemod/src/migrations/v1-to-v2/transforms/index.ts` — delete its import and its entry in the exported transforms array.

- [ ] **Step 4: Delete the transform + its unit test**

```bash
git rm packages/codemod/src/migrations/v1-to-v2/transforms/specSchemaAccess.ts
git rm packages/codemod/test/v1-to-v2/transforms/specSchemaAccess.test.ts
```

- [ ] **Step 5: Update integration tests.** Search for residual expectations and fix them:

Run: `grep -rn "specTypeSchemas\|~standard\|specSchemaAccess" packages/codemod/test packages/codemod/src/migrations`
Expected after fixes: only legitimate references remain (none asserting the codemod *produces* `specTypeSchemas`). Update `test/integration.test.ts` cases that expected `.parse`→`validate` rewrites to instead expect the schema usage unchanged.

- [ ] **Step 6: Run the full codemod suite**

Run: `pnpm --filter @modelcontextprotocol/codemod test`
Expected: all PASS.

- [ ] **Step 7: Typecheck + lint the codemod** (catches the dangling `specSchemaAccess` import and any unused `specSchemaMap` reference)

Run: `pnpm --filter @modelcontextprotocol/codemod check`
Expected: PASS. If `src/generated/specSchemaMap.ts` / `scripts/generateSpecSchemaMap.ts` are now unused, remove them and the `generate:spec-schemas` prebuild step; otherwise leave them.

- [ ] **Step 8: Commit** (print for the user)

```bash
git add packages/codemod
git commit -m "refactor(codemod): drop specSchemaAccess; schema usage migrates by path swap"
```

---

## Phase 3 — Batch-test validation + docs

### Task 3.1: Teach the batch test about `sdk-shared` and re-validate firebase-tools

**Files:**
- Modify: `packages/codemod/src/bin/batchTest.ts`

**Interfaces:**
- Consumes: the packed local tarballs.
- Produces: the batch test packs `sdk-shared` and forces the transitive `server`/`client` → `sdk-shared` edge to resolve to the local tarball.

- [ ] **Step 1: Add `sdk-shared` to `LOCAL_PACKAGE_DIRS`** in `packages/codemod/src/bin/batchTest.ts`:

```ts
    '@modelcontextprotocol/sdk-shared': path.join(SDK_ROOT, 'packages/sdk-shared'),
```

- [ ] **Step 2: Force transitive resolution via `overrides`.** In `rewriteToLocalTarballs` (or right after it), ensure the consumer `package.json` gets an `overrides` map pinning `@modelcontextprotocol/sdk-shared` (and the other v2 packages) to their local tarball paths, so `server`'s own `^2.0.0-alpha.2` dependency on `sdk-shared` resolves locally. Add, after the dependency rewrite loop:

```ts
    // npm/pnpm: pin transitive @modelcontextprotocol/* (e.g. server -> sdk-shared) to local tarballs.
    const overrides = (pkgJson.overrides as Record<string, string> | undefined) ?? {};
    for (const [name, tarballPath] of Object.entries(tarballs)) {
        overrides[name] = `file:${tarballPath}`;
    }
    pkgJson.overrides = overrides;
    rewrites++; // ensure the file is written
```

(If the manifest's package manager is pnpm, the equivalent key is `pnpm.overrides`; firebase-tools uses npm, so top-level `overrides` is correct. Generalize only if a pnpm repo is added.)

- [ ] **Step 3: Rebuild SDK packages and re-run the batch test**

Run: `pnpm build:all && pnpm --filter @modelcontextprotocol/codemod batch-test`
Expected: completes; `packages/codemod/batch-test/results/summary.json` shows `firebase/firebase-tools` with `newErrors.typecheck: 0`.

- [ ] **Step 4: Confirm the win in the report**

Run: `node -e "const r=require('./packages/codemod/batch-test/results/firebase_firebase-tools/report.json');const p=r.packages[0];console.log('post typecheck exit:',p.postCodemod.typecheck.exitCode);console.log('Unknown SDK import path diags:',p.codemod.diagnostics.filter(d=>d.message.includes('Unknown SDK import path')).length);console.log('project-type diags:',p.codemod.diagnostics.filter(d=>d.message.includes('Could not determine project type')).length);"`
Expected: `post typecheck exit: 0`; `Unknown SDK import path diags: 0`; `project-type diags: 0`. Spot-check `repos/firebase_firebase-tools/src/mcp/onemcp/onemcp_server.ts` — the `.parse()` calls are intact and import `*Schema` from `@modelcontextprotocol/sdk-shared`.

- [ ] **Step 5: Commit** (print for the user)

```bash
git add packages/codemod/src/bin/batchTest.ts
git commit -m "test(codemod): pack sdk-shared and pin transitive deps in batch test"
```

---

### Task 3.2: Migration docs + finalize

**Files:**
- Modify: `docs/migration.md`, `docs/migration-SKILL.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Rewrite the spec-schema validation section in `docs/migration.md`.** Replace the `CallToolResultSchema` → `specTypeSchemas.X['~standard'].validate()` guidance (around the section found by `grep -n "specTypeSchemas\|CallToolResultSchema" docs/migration.md`) with:

```md
### Schema validation (`*Schema.parse` / `.safeParse`)

The Zod schema constants moved to `@modelcontextprotocol/sdk-shared`. Update the import path; the schemas are unchanged Zod schemas, so `.parse()`, `.safeParse()`, `.extend()`, etc. keep working.

```ts
// v1
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
// v2
import { CallToolResultSchema } from '@modelcontextprotocol/sdk-shared';

const result = CallToolResultSchema.parse(value); // unchanged
```

For library-agnostic (Standard Schema) validation that does not couple your code to Zod, use `specTypeSchemas` from `@modelcontextprotocol/server` or `@modelcontextprotocol/client` instead:

```ts
import { specTypeSchemas } from '@modelcontextprotocol/server';
const r = specTypeSchemas.CallToolResult['~standard'].validate(value); // { value, issues }
```
```

- [ ] **Step 2: Update `docs/migration-SKILL.md`** — replace the mapping-table rows that map `<TypeName>Schema.parse(value)` → `specTypeSchemas.<TypeName>['~standard'].validate(value)` with a row mapping the **import path**: `import … from '@modelcontextprotocol/sdk/types.js'` → `import … from '@modelcontextprotocol/sdk-shared'` (schemas and types), and note that `.parse`/`.safeParse` are unchanged. Keep the `specTypeSchemas` row as the optional library-agnostic alternative.

- [ ] **Step 3: Sync snippets + docs check**

Run: `pnpm sync:snippets && pnpm run docs:check`
Expected: PASS (or no changes). Fix any snippet drift.

- [ ] **Step 4: Final full-repo gate**

Run: `pnpm check:all && pnpm test:all`
Expected: all PASS.

- [ ] **Step 5: Commit** (print for the user)

```bash
git add docs/migration.md docs/migration-SKILL.md
git commit -m "docs(migration): schemas import from @modelcontextprotocol/sdk-shared"
```

---

## Self-Review

**Spec coverage:** package creation (1.1), spec types + Zod schema move (1.2), first-class Zod positioning / no nudge (codemod has no nudge; docs present both — 2.2/2.3/3.2), regular `dependency` model (1.3/1.4), external-not-bundled (1.4), types-only re-export keeping the surface Zod-free (1.2 `./types` + 1.3 shim), `specTypeSchemas` unchanged (1.3), churn-limiting shims (1.3), codemod path swap (2.2), drop `specSchemaAccess` (2.3), batch-test wiring + 0-error validation (3.1), docs + changeset (1.1/3.2). PR #2277 supersession is covered by the `specSchemaAccess` removal (no `specTypeSchemas` rewrite produced). All spec sections map to a task.

**Placeholder scan:** no `TBD`/`TODO`; the one conditional (`tsconfig paths` in 1.3 Step 4 / 1.4 Step 4) is gated on a concrete typecheck failure with the exact lines to add. Move tasks specify exact `git mv` targets rather than reproducing the 2346-line `schemas.ts` (relocation, not authoring).

**Type/name consistency:** `@modelcontextprotocol/sdk-shared` used verbatim throughout; `./types` subpath defined in 1.1 (package.json exports + typesVersions), produced in 1.2 (built from `src/types.ts`), consumed in 1.3 (core `types.ts` shim) and 1.4 (server/client dts paths); `lookupImportMapping` (2.2) matches the existing helper; `LOCAL_PACKAGE_DIRS`/`rewriteToLocalTarballs`/`tarballs` (3.1) match `batchTest.ts`.

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, with review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Note: every "Commit" step prints commands for **you** to run (the `git add`/`git commit` hook blocks the agent from committing).
