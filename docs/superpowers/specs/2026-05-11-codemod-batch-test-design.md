# Codemod Batch Test: Design Spec

Repeatable process for running the MCP v1-to-v2 codemod against real-world repos, identifying issues, and iterating on the codemod.

## Goal

Improve the codemod by testing it against 10-15 curated external repos. Each iteration: run the codemod, compare baseline vs. post-codemod check results, have Claude categorize failures, fix the codemod, repeat.

## System Overview

Three components, all living in `packages/codemod/batch-test/`:

1. **Repo manifest** (`repos.json`) -- JSON file listing target repos, their structure, and optional overrides.
2. **Batch runner** (`run-codemod-batch.sh`) -- Shell script that iterates the manifest: clones, installs, baselines, codemods, re-checks, writes structured output.
3. **Analysis prompt** (`analyze-prompt.md`) -- Instructions for Claude Code to run the script and analyze results in a single session.

### Data Flow

```
repos.json --> run-codemod-batch.sh --> results/<repo-slug>/report.json  (per-repo)
                                    --> results/summary.json             (consolidated)

Claude Code: runs script, reads results, produces categorized analysis
```

## Repo Manifest (`repos.json`)

An array of repo entries. Each entry represents a GitHub repo and one or more packages within it that use `@modelcontextprotocol/sdk` v1.

```json
[
  {
    "repo": "owner/repo-name",
    "ref": "main",
    "packages": [
      {
        "dir": "packages/mcp-server",
        "sourceDir": "src",
        "checks": {
          "typecheck": "npm run check:ts",
          "test": null
        }
      }
    ]
  }
]
```

### Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `repo` | yes | -- | GitHub `owner/name` |
| `ref` | no | `main` | Branch or tag to check out |
| `packages` | no | `[{ "dir": ".", "sourceDir": "src" }]` | Package targets within the repo |
| `packages[].dir` | yes | -- | Path to the package root (where its `package.json` lives) |
| `packages[].sourceDir` | no | `src` | Source directory relative to `dir` (passed to codemod) |
| `packages[].checks` | no | auto-detect | Override check commands; set a key to `null` to skip that check |

### Auto-Detection Rules

**Package manager** (first lockfile found at repo root):
- `pnpm-lock.yaml` -> `pnpm`
- `yarn.lock` -> `yarn`
- `package-lock.json` -> `npm`
- `bun.lockb` -> `bun`

**Check commands** (read `scripts` from the package's `package.json`, first match wins):

| Check | Script names probed (in order) | Fallback |
|-------|-------------------------------|----------|
| typecheck | `typecheck`, `type-check`, `check:types`, `tsc` | `npx tsc --noEmit` |
| build | `build`, `compile` | skip |
| test | `test`, `test:unit`, `test:all` | skip |
| lint | `lint`, `lint:check` | skip |

The detected command runs as `<pm> run <script-name>`.

## Batch Runner (`run-codemod-batch.sh`)

### CLI

```bash
./run-codemod-batch.sh [--manifest repos.json] [--output-dir ./results] [--clone-dir ./repos] [--fresh-clones]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--manifest` | `./repos.json` | Path to repo manifest |
| `--output-dir` | `./results` | Where to write reports |
| `--clone-dir` | `./repos` | Where to clone repos |
| `--fresh-clones` | off | Force re-clone even if clone exists |

Clones are kept between runs by default for fast iteration.

### Per-Repo Flow

```
1. CLONE OR RESET
   - If clone exists: git restore . && git clean -fd
   - If no clone: git clone --depth 1 --branch <ref> <url> <path>

2. DETECT PACKAGE MANAGER
   - Check for lockfile at repo root

3. INSTALL
   - cd <repo-root> && <pm> install
   - If install fails: record error, skip to next repo

4. BASELINE CHECKS (for each package)
   - Auto-detect or use override check commands
   - Run: typecheck, build, test, lint
   - Capture: exit code, stdout, stderr for each

5. RUN CODEMOD (for each package)
   - node <sdk-root>/packages/codemod/dist/cli.mjs v1-to-v2 \
       <clone>/<pkg.dir>/<pkg.sourceDir> --verbose
   - Capture: full output, diagnostics, change count

6. RE-INSTALL
   - cd <repo-root> && <pm> install
   - Picks up new v2 deps from updated package.json files

7. POST-CODEMOD CHECKS (for each package)
   - Same checks as step 4, captured separately

8. WRITE REPORT
   - Write per-repo JSON to results/<repo-slug>/report.json
   - Append entry to summary
```

### Error Handling

If any step fails for a repo, the script logs the failure, writes what it has to the report, and moves to the next repo. One broken repo does not stop the batch.

### Path Resolution

The script resolves `SDK_ROOT` from its own location (`SDK_ROOT=$(cd "$(dirname "$0")/../../.." && pwd)`). All default paths (`--clone-dir`, `--output-dir`) are relative to the script's directory (`packages/codemod/batch-test/`).

### Codemod Binary

The script always uses the locally-built codemod from the current branch:
```
node "$SDK_ROOT/packages/codemod/dist/cli.mjs"
```
This ensures each run tests the current state of the codemod.

## Output Format

### Per-Repo Report (`results/<repo-slug>/report.json`)

```json
{
  "repo": "user/mcp-server-example",
  "ref": "main",
  "timestamp": "2026-05-11T14:30:00Z",
  "packageManager": "pnpm",
  "packages": [
    {
      "dir": ".",
      "sourceDir": "src",
      "codemod": {
        "filesChanged": 12,
        "totalChanges": 47,
        "diagnostics": [
          {
            "level": "warning",
            "file": "src/server.ts",
            "line": 42,
            "message": "Destructuring pattern for 'extra' -- review manually",
            "transformId": "context"
          }
        ]
      },
      "baseline": {
        "typecheck": { "exitCode": 0, "stdout": "", "stderr": "" },
        "build":     { "exitCode": 0, "stdout": "", "stderr": "" },
        "test":      { "exitCode": 0, "stdout": "", "stderr": "" },
        "lint":      { "exitCode": 0, "stdout": "", "stderr": "" }
      },
      "postCodemod": {
        "typecheck": { "exitCode": 2, "stdout": "", "stderr": "src/handler.ts(15,3): error TS2345: ..." },
        "build":     { "exitCode": 2, "stdout": "", "stderr": "..." },
        "test":      { "exitCode": 0, "stdout": "", "stderr": "" },
        "lint":      { "exitCode": 0, "stdout": "", "stderr": "" }
      }
    }
  ]
}
```

### Consolidated Summary (`results/summary.json`)

```json
{
  "timestamp": "2026-05-11T14:30:00Z",
  "codemodVersion": "2.0.0-alpha.0",
  "codemodCommit": "abc1234",
  "totalRepos": 12,
  "totalPackages": 15,
  "results": [
    {
      "repo": "user/mcp-server-example",
      "package": ".",
      "baselineClean": true,
      "postCodemodClean": false,
      "newErrors": { "typecheck": 3, "build": 1, "test": 0, "lint": 0 },
      "codemodDiagnostics": { "warning": 2, "error": 0, "info": 1 }
    }
  ],
  "aggregated": {
    "reposClean": 7,
    "reposWithNewErrors": 5,
    "totalNewTypecheckErrors": 18,
    "totalCodemodWarnings": 12,
    "topErrorPatterns": ["TS2345", "TS2339", "TS2554"]
  }
}
```

## Claude Analysis Workflow

### Prompt (`analyze-prompt.md`)

Saved in `packages/codemod/batch-test/analyze-prompt.md`. You tell Claude Code to follow these instructions:

```
Run the batch codemod test and analyze results:

1. Build the codemod:
   pnpm --filter @modelcontextprotocol/codemod build

2. Run the batch test:
   ./packages/codemod/batch-test/run-codemod-batch.sh

3. Read results/summary.json for the overview.

4. For each repo with new errors, read its results/<repo-slug>/report.json.

5. Categorize each new error (present in postCodemod but not in baseline):
   - codemod-bug: The transform produced incorrect output
   - missing-transform: The codemod should handle this pattern but doesn't
   - manual-migration: Expected -- documented in migration guide, needs human judgment
   - repo-specific: Unusual pattern unique to this repo, not worth handling

6. Produce findings grouped by category with:
   - Repo, file, line, error message
   - Root cause (one sentence)
   - For codemod-bug/missing-transform: which transform to fix and what correct output looks like

7. Produce a "Priority Fixes" list: top 3-5 codemod improvements sorted by impact
   (number of repos affected).
```

### Iteration Loop

```
1. Fix a codemod transform
2. Tell Claude: "Re-run the batch test and analyze"
   --> Claude rebuilds codemod, resets clones, re-runs, reads results, analyzes
3. Review Claude's findings
4. Go to 1
```

## Error Categorization Reference

| Category | Meaning | Action |
|----------|---------|--------|
| `codemod-bug` | Transform produced wrong output | Fix the transform |
| `missing-transform` | Pattern not handled | Add handling to existing transform or create new one |
| `manual-migration` | Requires human judgment (removed API, architectural change) | Ensure migration guide covers it; improve codemod diagnostic |
| `repo-specific` | Unusual pattern unique to one repo | Document but don't add to codemod |

## File Structure

```
packages/codemod/batch-test/
  repos.json              # Repo manifest (curated list)
  run-codemod-batch.sh    # Batch runner script
  analyze-prompt.md       # Claude analysis instructions
  repos/                  # Cloned repos (gitignored)
  results/                # Output reports (gitignored)
    summary.json
    <repo-slug>/
      report.json
```

`repos/` and `results/` are added to `.gitignore`. Only the manifest, script, and prompt are committed.
