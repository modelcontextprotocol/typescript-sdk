# surfacepin-lock

A stdio MCP server (`createServer` + `McpServer.registerTool` + `serveStdio`) checked against a committed `surfacepin.lock.json`.

The gate is the npm package [surfacepin](https://github.com/yellowgram/surfacepin) (`surfacepin@^1.5.0`, a devDependency of this example). It is not the SDK's internal behavior-surface pins in [`docs/behavior-surface-pins.md`](../../docs/behavior-surface-pins.md).

SurfacePin hashes the tools list (`name`, `description`, `inputSchema`, plus `annotations` and `outputSchema` when present) and exits non-zero when the digest changes. Pass/fail is exact-hash digest equality. `HINT_FLIP` is a field-diff label, not a safety verdict. This example is not a security or safety product.

`check.mjs` calls `pinStdio` / `verifyStdio`. The CLI is the same gate:

```bash
surfacepin lock   --stdio --surface tools -o surfacepin.lock.json -- <server>
surfacepin verify --stdio --surface tools surfacepin.lock.json -- <server>
```

## Run in this repo

`package.json` and `tsconfig.json` are monorepo-internal (`workspace:` / `catalog:` for the SDK; `surfacepin` is a normal devDependency). From the repo root, after `pnpm install`:

```bash
pnpm --filter @mcp-examples/surfacepin-lock typecheck
pnpm --filter @mcp-examples/surfacepin-lock start
```

`start` speaks MCP on stdio. A host spawns it.

`surfacepin@1.5.0` is younger than this repo's 7-day `minimumReleaseAge`, and it depends on v1 `@modelcontextprotocol/sdk@1.30.1`, which is also inside that window. `pnpm-workspace.yaml` lists both names under `minimumReleaseAgeExclude` so this example can install them. They are not runtime dependencies of the published SDK packages.

## Lock, commit, verify

1. Lock the live stdio server. This writes `surfacepin.lock.json` in this directory:

```bash
pnpm --filter @mcp-examples/surfacepin-lock lock
```

2. Commit that file. Do not rename it.

```bash
git add examples/surfacepin-lock/surfacepin.lock.json
```

3. Verify the same file. Digest drift exits non-zero. A missing lockfile exits non-zero. Verify does not rewrite the file.

```bash
pnpm --filter @mcp-examples/surfacepin-lock check
```

Re-lock only when the tools-list change is intentional, then commit the new `surfacepin.lock.json`.

`SKILL.md` is an optional generator note: when emitting an MCP server, add this lock and verify step. It is not loaded as a repo skill.

## CI or pre-commit

Run verify on the committed file. Do not regenerate the lock in CI.

```bash
npm install --save-dev surfacepin@^1.5.0
npx surfacepin verify --stdio --surface tools surfacepin.lock.json -- node build/index.js
```

Build first (`npm run build` in a standalone copy, or `pnpm --filter @mcp-examples/surfacepin-lock build` here once the SDK packages are built). In this repo, `check` runs `src/index.ts` through `tsx` instead of `build/index.js`.

## Standalone copy

Copy `src/index.ts` and `check.mjs` into a project outside the monorepo. Do not copy the `paths` in this `tsconfig.json`.

```bash
npm init -y
npm pkg set type=module
npm install @modelcontextprotocol/server zod
npm install --save-dev typescript tsx surfacepin@^1.5.0
```

Point the server command at that project's entry (`tsx src/index.ts` or `node build/index.js`), then lock, commit `surfacepin.lock.json`, and verify that file.
