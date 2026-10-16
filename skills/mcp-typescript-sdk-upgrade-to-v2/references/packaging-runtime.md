### Packaging & runtime

The single `@modelcontextprotocol/sdk` package is split:

| v1                              | v2                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `@modelcontextprotocol/sdk`     | `@modelcontextprotocol/client` (client implementation)                                                                          |
|                                 | `@modelcontextprotocol/server` (server implementation)                                                                          |
|                                 | `@modelcontextprotocol/core` (public Zod `*Schema` constants)                                                                   |
|                                 | `@modelcontextprotocol/core-internal` (internal — never import directly)                                                        |
| Built-in HTTP framework support | `@modelcontextprotocol/node` / `@modelcontextprotocol/express` / `@modelcontextprotocol/hono` / `@modelcontextprotocol/fastify` |

`@modelcontextprotocol/client` and `@modelcontextprotocol/server` both re-export shared
types from `@modelcontextprotocol/core-internal`, so import types and error classes from
whichever package you already depend on. `@modelcontextprotocol/core-internal` is
`private: true` and is not published — **do not import from it directly.**
`@modelcontextprotocol/core` is the public Zod-schema package (raw `*Schema` constants
only); see [Zod `*Schema` constants moved to `@modelcontextprotocol/core`](types-schemas.md#zod-schema-constants-moved-to-modelcontextprotocolcore) below.

After the codemod runs, review the manifest summary it prints: the swap rewrites the
**nearest** manifest found walking up from the target directory — one manifest total.
Workspace-member manifests in a monorepo are never modified; instead the codemod lists
each member that still declares the v1 SDK together with the exact dependency changes
it needs (remove the v1 entry, add the v2 packages that member's imports use) — apply
those edits yourself, then install. The v2 additions are computed from the final import
state of each package's sources, so already-migrated sources still receive the v2
packages they need when the v1 dependency is removed. In a hoisted monorepo (members
without their own SDK dependency), member usage counts toward the manifest that
declares the v1 SDK, and the summary notes which members contributed. See
[Monorepo workspace members](#monorepo-workspace-members) for how to decide each
member's packages.

#### Monorepo workspace members

Declare in every member exactly what its own sources import: files importing
`@modelcontextprotocol/server` (or its subpaths) need `@modelcontextprotocol/server`;
client imports need `@modelcontextprotocol/client`; raw `*Schema` constants need
`@modelcontextprotocol/core`; a framework adapter import (`@modelcontextprotocol/express`
etc.) needs the adapter package **plus the framework itself** in that member (the
adapter declares it as a peer dependency). Place a package in `dependencies` when
shipped runtime code imports it and in `devDependencies` when only tests, fixtures, or
local tooling do — when in doubt, use the section where the member previously declared
`@modelcontextprotocol/sdk`.

A member that never declared the v1 SDK and resolved it through the root can keep
root-level declarations (the codemod's root rewrite already adds the union of the
contributing members' v2 packages — its hoisting note names them) or move to
per-member declarations; per-member is recommended, since the v2 package split makes each member's
actual needs explicit. To answer "which packages does this member need" directly, run
the codemod against that member's directory with `--dry-run`: the manifest summary is
computed from that member's own imports. (The authoritative import-path routing lives
in the codemod's [mapping file](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/codemod/src/migrations/v1-to-v2/mappings/importMap.ts).)

The framework adapter packages declare their framework as a **peer dependency**
(`express`, `hono`, `fastify`); v1 shipped them as direct deps. The codemod adds the
`@modelcontextprotocol/*` packages your imports use, but does not add the framework
peer — install it explicitly (`pnpm add express` etc.). `@modelcontextprotocol/node`
depends on `@hono/node-server` at runtime (Node HTTP ↔ Web Standard conversion) and
installs `hono` as a regular dependency only because `@hono/node-server` requires it as
a peer — the adapter does not use the `hono` framework itself.

v2 requires **Node.js 20+**. It is ESM-first but ships a **CommonJS build alongside
ESM**, so CommonJS projects can `require('@modelcontextprotocol/…')` directly — no
dynamic `import()` shim required.

Repo-local tooling that encodes the literal v1 package name — dependency-pin lints,
version allowlists, CI checks, scripts — fails after the manifest swap and is invisible
to the codemod (it rewrites sources and manifests, not bespoke gates). Grep for
`@modelcontextprotocol/sdk` outside `src/` before declaring the migration done. While
grepping, also remove v1-era double casts on SDK types (`as unknown as Transport` and
similar, usually annotated to a v1 issue) — v2's types satisfy those contracts
directly, and a surviving cast keeps suppressing type checking that would otherwise
catch real errors.

Tooling that pins SDK **dist text** (reading a constant out of a built file with
`require.resolve` + a regex) breaks in two stacked ways: the literal usually lives in a
content-hashed sibling chunk (`dist/sse-<hash>.mjs`), not the subpath's entry module,
so fixed-path reads do not survive a rebuild — scan the package's `dist/` directory
for the literal instead; and the emitted quote style differs from v1, so a
quote-anchored pattern misses silently — match either quote. The build layout also
changed: v2 emits `.mjs`/`.cjs` siblings in a flat `dist/`, so v1's `/dist/cjs/` ↔
`/dist/esm/` flavor-pair path swaps have no equivalent.

#### Registry availability

All v2 packages are published on the public npm registry. Two notes:

- As of `2.0.0-beta.1` all v2 packages share one version number (earlier alphas
  did not). The codemod writes ranges that match what is published, so prefer its
  manifest output over hand-pinning every package.
- Environments that resolve through a corporate or private registry mirror may not
  have synced the newer scoped packages yet (the symptom is "not found" for a package
  that exists on npmjs.org). Point the install at the public registry
  (`npm install --registry=https://registry.npmjs.org/` or the equivalent `.npmrc`
  entry), ask your mirror's operators to sync the `@modelcontextprotocol` scope, or —
  where neither is possible — build a tarball from a checkout of this repository
  (`pnpm install && pnpm build`, then `pnpm pack` in the package directory) and
  reference it with a committed `file:` dependency.

#### CommonJS test runners (Jest)

v2 ships a CommonJS build, so CJS test runners resolve the packages natively through the
`require` export condition — Jest (including `next/jest` setups) no longer needs a
`moduleNameMapper` workaround to import `@modelcontextprotocol/*`. If you carried a
v1-era mapping that pinned these packages to their `dist/*.mjs` files, remove it. Vitest
and native Node ESM are unaffected.

#### Bundlers: nested `zod` copies in zod@3-pinned monorepos

v1's `zod ^3.25 || ^4.0` peer range deduplicated onto a workspace's hoisted zod@3. The
v2 packages depend on `zod ^4.2.0`, so in a workspace that pins zod@3 the dependency
cannot dedupe — each installed v2 package resolves its own nested zod@4 copy. Two
bundler consequences:

- **Path-substring vendor pins capture the nested copies.** Bundler rules that match
  zod by module path — `manualChunks` pins, vendor-chunk matchers, bundle budgets keyed
  on a `zod/` path segment — also match `@modelcontextprotocol/*/node_modules/zod`,
  which can pull the nested copies into an eagerly-loaded vendor chunk and trip a
  budget gate. Exclude the SDK-nested paths from such pins so the copies ride with the
  SDK's own (typically lazy) chunks.
- **Ballpark size cost.** Measured on a large production SPA, adding the v2 client and
  server packages (with their nested zod@4 copies) alongside a hoisted zod@3 cost
  roughly +83 KB gzipped of total JS (about +0.7% whole-app). Upgrading the workspace
  to `zod ^4.2.0` re-dedupes and removes the duplication.

#### Migrating in stages (large codebases)

The v1 package and the v2 packages have **different names**, so both can be installed
in one manifest at the same time — nothing forces a one-shot swap. The safe order for
an incremental migration: (1) add the v2 packages (and the `zod ^4.2.0` bump) while
**keeping** `@modelcontextprotocol/sdk`; (2) rewrite sources incrementally,
directory-by-directory or package-by-package; (3) remove the v1 dependency only when
nothing imports it any more (`grep -rn "@modelcontextprotocol/sdk" --include="*.ts"`,
plus a look at `package.json`). The inverse order strands files: swapping the manifest
first leaves every not-yet-rewritten import failing module resolution (TS2307) until it
is updated.

Two caveats for the transition window. First, a codemod run against a subdirectory
still updates the nearest manifest walking up — including removing the v1 dependency —
so during a staged pass review or revert that edit until the final stage (or preview
with `--dry-run`). Second, v1 and v2 modules each have their own classes and types:
objects must not flow between v1-imported and v2-imported code (`instanceof` and
nominal types do not cross — the same boundary described for dual-role processes in
[Errors](errors.md#errors)), so stage along process or transport boundaries where the two sides
share only the wire format; the two sides negotiate
a protocol version through the ordinary 2025-era `initialize` handshake and settle
on the newest revision both packages support (currently 2025-11-25 — published v1
1.29.x and v2 ship the same supported-version list).

Dependencies you do not control (vendored fixtures, third-party packages) that still
declare `@modelcontextprotocol/sdk` resolve their own v1 copy and need no action. For
`peerDependencies` declarations, keep the v1 package installed to satisfy the range —
or point the name at a chosen version via your package manager's
`overrides`/`resolutions` — until those packages migrate. The same boundary rule
applies: objects must not flow between their v1-imported code and your v2-imported
code.

**Dependencies that compile against the host's v1 SDK.** A stricter variant of the
above: a workspace or vendored package that ships TypeScript **source** importing
`@modelcontextprotocol/sdk` — resolved from the host's `node_modules` rather than its
own — pins the host. Keep the v1 package installed as a real dependency (not merely a
surviving transitive) until that package migrates. The host files that construct or
hand objects to such a package are part of its v1 boundary and must stay on v1 imports
— and the codemod cannot see that distinction: it rewrites them like any other file
(e.g. converting a `setRequestHandler(Schema, …)` call into the v2 method-string form
against what is still a v1 `Server`, which then fails at runtime). Run the codemod with
`--ignore` glob patterns covering those interfacing files, and migrate them together
with the dependency later. The boundary rule above applies unchanged: objects from the
dependency's v1 modules must never flow into v2-imported code.

#### Library authors: peer-depending on the SDK

If your package declares `@modelcontextprotocol/sdk` as a `peerDependency`, the v2
packages are differently **named**, so swapping the peer declaration is itself a
breaking change for every consumer — ship it as a semver-major. You can migrate
ahead of your consumers only if no SDK object crosses your public API (the
v1/v2 boundary rule above applies to your exports too: a v1-constructed `Client`
or error instance handed to v2-importing consumer code fails `instanceof` and
nominal checks). Until your consumers migrate, they can keep resolving your peer
range with the v1 package installed alongside their own v2 packages — the two
coexist under different names.
