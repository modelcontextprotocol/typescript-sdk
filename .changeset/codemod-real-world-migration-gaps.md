---
'@modelcontextprotocol/codemod': patch
---

Fix a batch of v1→v2 codemod gaps surfaced by real-world migrations:

- Directory walk no longer follows symlinks and prunes ignored directories during descent, so a pnpm workspace with a cyclic intra-workspace dev-dependency no longer crashes with `ELOOP`, and `--ignore` actually skips a tree.
- Every workspace-member `package.json` that depends on the v1 SDK is now updated (not just the one closest to the target directory); `RunnerResult.packageJsonChanges` is now an array.
- A `zod@^3` dependency is reported (not rewritten) with guidance to bump to `^4` or pin `^3.25+` and import from `zod/v4`.
- New `--prefer client|server` flag overrides the hard-coded `server` default when no client/server signal is found.
- Leading file-header comments (JSDoc and `//` blocks) are preserved across the full transform pipeline, including when a later transform removes the rewritten first import.
- Type-position `import('@modelcontextprotocol/sdk/...').<Name>` qualifiers are rewritten and routed per-symbol.
- The `extra → ctx` remap now reaches `as`-cast/parenthesized callbacks, `fallbackRequestHandler` assignments, and single-parameter (schema-less) register callbacks; parameters typed `ServerContext`/`ClientContext` that still access v1 properties are marked with an `@mcp-codemod-error` comment.
- `error.code` accesses on an `instanceof`-checked `StreamableHTTPError`/`SdkHttpError` are marked (the HTTP status moved to `.status`).
- `require()`/`require.resolve()` of a v1 SDK path is marked (v2 subpath exports have no `require` condition).
- Wrapping a raw shape with `z.object()` now adds `import { z } from 'zod'` when missing and warns about the `zod` dependency.
