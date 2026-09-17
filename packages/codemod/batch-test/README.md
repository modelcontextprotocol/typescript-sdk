# Codemod Batch Test

Tests the v1-to-v2 codemod against real-world repos to find bugs, missing transforms, and gaps.

## How it works

For each repo in `repos.json`, the batch test:

1. Clones the repo (or resets an existing clone)
2. Installs dependencies
3. Runs baseline checks (typecheck, build, test, lint) to confirm the repo is healthy
4. Runs the codemod — in-process via the programmatic API (`--codemod=local`, the default), or by shelling out to the published CLI via `npx` (`--codemod=published`)
5. Packs local SDK packages as tarballs and rewrites `package.json` deps to use them, so the test runs against the current SDK branch — only when `--sdk=local` (the default); with `--sdk=published` the v2 deps are installed from npm instead (see [Modes](#modes))
6. Re-installs dependencies
7. Re-runs the same checks
8. Writes structured JSON reports

Errors that appear in step 7 but not step 3 are codemod-introduced regressions.

## Usage

```bash
# Build all SDK packages first (tarballs need built dist/)
pnpm build:all

# Run the batch test
pnpm --filter @modelcontextprotocol/codemod batch-test

# Clean cloned repos, results, and tarballs
pnpm --filter @modelcontextprotocol/codemod batch-test:clean
```

## Modes

Each run independently chooses where the **SDK packages** and the **codemod** come from:

| Flag                       | Values                 | Default   | Effect                                                                                                              |
| -------------------------- | ---------------------- | --------- | ------------------------------------------------------------------------------------------------------------------- |
| `--sdk`                    | `local` \| `published` | `local`   | `local`: pack local packages and rewrite deps to `file:` tarballs. `published`: install the v2 deps from npm.       |
| `--codemod`                | `local` \| `published` | `local`   | `local`: run the working-copy codemod in-process. `published`: `npx` the published CLI.                             |
| `--codemod-version <spec>` | npm version/tag/range  | `latest`  | Only with `--codemod=published`.                                                                                    |
| `--sdk-version <spec>`     | npm version/tag/range  | _(unset)_ | Only with `--sdk=published`. Pins each v2 dep to its own resolved version. Unset = use whatever the codemod writes. |

Both `--flag value` and `--flag=value` forms work.

```bash
# default (today's behavior)
pnpm --filter @modelcontextprotocol/codemod batch-test

# both from npm @latest
pnpm --filter @modelcontextprotocol/codemod batch-test -- --sdk=published --codemod=published
```

Published specs are resolved to concrete versions via `npm view` at startup. A failure resolving the codemod version or the representative SDK label aborts the run; a per-package `--sdk-version` miss only warns and leaves that package on the codemod-written range. Each
`@modelcontextprotocol/*` package is resolved **independently** — they are not released in lockstep. Results are written to a per-run directory keyed on the resolved versions; the SDK segment is the resolved `@modelcontextprotocol/server` version used as a representative label,
while the full per-package set is recorded in `summary.json` → `sdkVersions`:

```
results/codemod-local__sdk-local/                  # default (--sdk=local --codemod=local)
results/codemod-2.0.0-alpha.2__sdk-2.0.0-alpha.2/  # --codemod=published --sdk=published --sdk-version=2.0.0-alpha.2
results/codemod-2.0.0-alpha.2__sdk-from-codemod/   # --codemod=published --sdk=published  (no --sdk-version)
```

The segment `sdk-from-codemod` appears when `--sdk=published` with no `--sdk-version` and `--codemod=published` (the SDK version is baked into the published codemod and only known after install; the installed versions are recorded in `summary.json` → `sdkVersions`).

**Limitation:** in published-codemod mode the CLI emits text, not structured diagnostics, so `codemod.diagnostics` is empty and the raw CLI output is captured under `codemod.cli` instead. Diagnostics categorization applies only to local-codemod runs.

## Output

Results are written to a per-run directory keyed on the resolved versions, `batch-test/results/<config>/`, where `<config>` is the `codemod-…__sdk-…` leaf (distinct `--codemod-version`/`--sdk-version` values produce distinct directories even within the same `--sdk`/`--codemod`
mode; see [Modes](#modes)):

- `results/<config>/summary.json` — overview across all repos: which passed, which failed, error counts, plus the run `config` and the resolved per-package `sdkVersions`
- `results/<config>/<repo-slug>/report.json` — per-repo detail: baseline vs post-codemod check results, codemod diagnostics, change counts

## Repo manifest (`repos.json`)

An array of repo entries. Each entry specifies a GitHub repo and one or more packages within it.

```json
{
    "repo": "owner/repo-name",
    "ref": "main",
    "packages": [
        {
            "dir": "packages/mcp-server",
            "sourceDir": "src",
            "checks": {
                "typecheck": "npx tsc --noEmit",
                "build": "npm run build",
                "test": "npm run test",
                "lint": null
            }
        }
    ]
}
```

| Field                  | Required | Default                                | Description                                                       |
| ---------------------- | -------- | -------------------------------------- | ----------------------------------------------------------------- |
| `repo`                 | yes      | —                                      | GitHub `owner/name`                                               |
| `ref`                  | no       | `main`                                 | Branch or tag to clone                                            |
| `packages`             | no       | `[{ "dir": ".", "sourceDir": "src" }]` | Package targets within the repo                                   |
| `packages[].dir`       | yes      | —                                      | Path to package root (where `package.json` lives)                 |
| `packages[].sourceDir` | no       | `src`                                  | Source directory relative to `dir` (passed to codemod)            |
| `packages[].checks`    | no       | auto-detect                            | Override check commands; set a value to `null` to skip that check |

When `checks` is omitted, the runner auto-detects commands from the package's `package.json` scripts (probing names like `typecheck`, `build`, `test`, `lint`). The package manager is auto-detected from the lockfile at the repo root.

## Analyzing results

`analyze-prompt.md` contains instructions for Claude Code to run the batch test and produce a categorized analysis. Each error is classified as:

| Category            | Meaning                                            |
| ------------------- | -------------------------------------------------- |
| `codemod-bug`       | A transform produced incorrect output              |
| `missing-transform` | The codemod should handle this pattern but doesn't |
| `manual-migration`  | Expected — requires human judgment                 |
| `repo-specific`     | Unusual pattern not worth handling in the codemod  |

## Adding a repo

1. Edit `repos.json` and add an entry
2. Run `pnpm --filter @modelcontextprotocol/codemod batch-test`
3. Check `results/<config>/<repo-slug>/report.json` for new findings

For monorepos, list each package that uses `@modelcontextprotocol/sdk` as a separate entry in `packages`.

## Iteration workflow

```
1. Run the batch test
2. Review results — identify codemod bugs / missing transforms
3. Fix the codemod transforms
4. Run batch-test:clean, then re-run the batch test
5. Confirm the fixes resolved the issues
6. Repeat
```
