# Codemod Batch Test: Analysis

## Context

The MCP TypeScript SDK is migrating from a single v1 package (`@modelcontextprotocol/sdk`) to a multi-package v2 architecture (`@modelcontextprotocol/client`, `/server`, `/core`, `/node`, `/express`). This involves renamed APIs, restructured context objects, removed modules, and
new import paths.

The `@modelcontextprotocol/codemod` package automates the mechanical parts of this migration. It runs 9 ordered AST transforms via ts-morph: import path rewrites, symbol renames, McpServer API restructuring, handler registration changes, context property remapping, and more. It
also updates `package.json` to swap v1 deps for v2.

The **batch test** runs this codemod against a curated list of real-world repos that use the v1 SDK. For each repo it:

1. Clones and installs
2. Runs baseline checks (typecheck, build, test, lint) to confirm the repo is healthy before migration
3. Runs the codemod
4. Re-installs (package.json was updated with v2 deps)
5. Re-runs the same checks

The goal is to find issues in the codemod itself — incorrect transforms, missing transforms, or gaps — so we can fix them.

## Instructions

1. Build the codemod:

    ```
    pnpm --filter @modelcontextprotocol/codemod build
    ```

2. Run the batch test:

    ```
    pnpm --filter @modelcontextprotocol/codemod batch-test
    ```

3. Read `packages/codemod/batch-test/results/summary.json` for the overview. Note which repos have `postCodemodClean: false` and which check types have new errors.

4. For each repo with new errors, read its `packages/codemod/batch-test/results/<repo-slug>/report.json`. Compare `baseline` vs `postCodemod` for each check — only errors that appear in `postCodemod` but not in `baseline` are codemod-introduced.

5. Also review the `codemod.diagnostics` array in each report — these are warnings the codemod itself emitted about patterns it couldn't fully handle.

6. For each codemod-introduced error, look at the actual source file in the cloned repo (`packages/codemod/batch-test/repos/<repo-slug>/...`) to understand what the codemod produced and what it should have produced.

7. Categorize each finding using the categories below, then produce the output described in the Output Format section.

## Error Categories

| Category            | Meaning                                                                                                                            | What to do                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `codemod-bug`       | A transform produced incorrect output — the code it generated is wrong                                                             | Identify which transform is responsible and what the correct output should be. This is a bug to fix in the codemod. |
| `missing-transform` | The codemod left v1 code untouched that it should have migrated                                                                    | Identify the v1 pattern and which existing transform should handle it, or whether a new transform is needed.        |
| `manual-migration`  | The error is expected — the migration guide documents this as requiring human judgment (e.g., removed APIs, architectural changes) | Verify the codemod emitted a diagnostic for it. If not, add one.                                                    |
| `repo-specific`     | An unusual pattern unique to this repo that isn't worth handling in the codemod                                                    | Note it briefly but don't suggest codemod changes.                                                                  |

## Output Format

### Summary

- Repos tested: X
- Repos clean after codemod: Y
- Repos with new errors: Z
- Total codemod-introduced errors: N

### Findings by Category

#### Codemod Bugs

| Repo | File:Line | Error | Transform | Root Cause | Correct Output |
| ---- | --------- | ----- | --------- | ---------- | -------------- |

#### Missing Transforms

| Repo | File:Line | Error | v1 Pattern | Suggested Fix |
| ---- | --------- | ----- | ---------- | ------------- |

#### Manual Migration (expected)

| Repo | File:Line | Error | Has Diagnostic? | Migration Guide Reference |
| ---- | --------- | ----- | --------------- | ------------------------- |

#### Repo-Specific

| Repo | File:Line | Error | Why Not Worth Handling |
| ---- | --------- | ----- | ---------------------- |

### Priority Fixes

List the top 3-5 codemod improvements that would fix the most repos, ordered by impact (number of repos affected). For each, state: what to change, in which transform, and how many repos it would fix.
