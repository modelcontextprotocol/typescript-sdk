# Codemod Batch Test

Tests the v1-to-v2 codemod against real-world repos to find bugs, missing transforms, and gaps.

## How it works

For each repo in `repos.json`, the batch test:

1. Clones the repo (or resets an existing clone)
2. Installs dependencies
3. Runs baseline checks (typecheck, build, test, lint) to confirm the repo is healthy
4. Runs the codemod using the programmatic API
5. Packs local SDK packages as tarballs and rewrites `package.json` deps to use them (so the test runs against the current SDK branch, not published npm versions)
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

## Output

Results are written to `batch-test/results/`:

- `summary.json` — overview across all repos: which passed, which failed, error counts
- `<repo-slug>/report.json` — per-repo detail: baseline vs post-codemod check results, codemod diagnostics, change counts

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

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `repo` | yes | — | GitHub `owner/name` |
| `ref` | no | `main` | Branch or tag to clone |
| `packages` | no | `[{ "dir": ".", "sourceDir": "src" }]` | Package targets within the repo |
| `packages[].dir` | yes | — | Path to package root (where `package.json` lives) |
| `packages[].sourceDir` | no | `src` | Source directory relative to `dir` (passed to codemod) |
| `packages[].checks` | no | auto-detect | Override check commands; set a value to `null` to skip that check |

When `checks` is omitted, the runner auto-detects commands from the package's `package.json` scripts (probing names like `typecheck`, `build`, `test`, `lint`). The package manager is auto-detected from the lockfile at the repo root.

## Analyzing results

`analyze-prompt.md` contains instructions for Claude Code to run the batch test and produce a categorized analysis. Each error is classified as:

| Category | Meaning |
|----------|---------|
| `codemod-bug` | A transform produced incorrect output |
| `missing-transform` | The codemod should handle this pattern but doesn't |
| `manual-migration` | Expected — requires human judgment |
| `repo-specific` | Unusual pattern not worth handling in the codemod |

## Adding a repo

1. Edit `repos.json` and add an entry
2. Run `pnpm --filter @modelcontextprotocol/codemod batch-test`
3. Check `results/<repo-slug>/report.json` for new findings

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
