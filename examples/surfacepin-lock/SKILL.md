---
name: surfacepin-lock
description: When generating an MCP TypeScript server, add surfacepin.lock.json and a verify step that fails on digest drift. Use for a new MCP server, a tools/list change, or a CI gate. Exact-hash equality only. Not a safety product.
---

# Lock the tools list

When you generate an MCP server with this SDK:

1. Write `createServer()` with `new McpServer(...)`, `registerTool`, and `serveStdio` from `@modelcontextprotocol/server` and `@modelcontextprotocol/server/stdio`.
2. Leave hashing out of the server. The gate is the external `surfacepin` package.
3. Install `surfacepin@^1.4.0` (`npm install --save-dev surfacepin@^1.4.0`, or `npx --yes surfacepin@1.4.0`). Do not require `surfacepin@1.5.0`. `pinStdio` / `verifyStdio` are optional once that version is on npm; the 1.4 CLI is enough.
4. Lock the live stdio process and commit the file under the exact name `surfacepin.lock.json`:

```bash
surfacepin lock --stdio --surface tools -o surfacepin.lock.json -- <server command>
```

5. Verify that same file in CI or pre-commit. Exit non-zero if the digest drifts or the file is missing:

```bash
surfacepin verify --stdio --surface tools surfacepin.lock.json -- <server command>
```

Pass/fail is exact-hash digest equality. `HINT_FLIP` is a field-diff label, not a safety verdict. Do not describe SurfacePin as a security or safety product.

This is the npm package `surfacepin`. It is not `docs/behavior-surface-pins.md`.

Do not add a payment, hosted account, or upgrade step.
