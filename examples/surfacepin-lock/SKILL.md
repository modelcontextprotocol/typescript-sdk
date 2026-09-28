---
name: surfacepin-lock
description: When generating an MCP TypeScript server, add surfacepin.lock.json and a verify step that fails on digest drift. Use for a new MCP server, a tools/list change, or a CI gate. Exact-hash equality only. Not a safety product.
---

# Lock the tools list

When you generate an MCP server with this SDK:

1. Write `createServer()` with `new McpServer(...)`, `registerTool`, and `serveStdio` from `@modelcontextprotocol/server` and `@modelcontextprotocol/server/stdio`.
2. Leave hashing out of the server. The gate is the external `surfacepin` package.
3. Install `surfacepin@^1.5.0` (`npm install --save-dev surfacepin@^1.5.0`).
4. Lock the live stdio process with `pinStdio` and commit the file under the exact name `surfacepin.lock.json`. Verify with `verifyStdio`. Pass/fail is `ok` from digest equality:

```js
import { readFileSync } from 'node:fs';
import { pinStdio, verifyStdio } from 'surfacepin';

const pinned = await pinStdio({ command: 'node', args: ['server.mjs'], surfaces: ['tools'] });
const checked = await verifyStdio({
  command: 'node',
  args: ['server.mjs'],
  surfaces: ['tools'],
  lockfile: JSON.parse(readFileSync('surfacepin.lock.json', 'utf8')),
});
if (!checked.ok) process.exit(1);
```

The CLI is the same gate:

```bash
surfacepin lock --stdio --surface tools -o surfacepin.lock.json -- <server command>
surfacepin verify --stdio --surface tools surfacepin.lock.json -- <server command>
```

5. Verify that same file in CI or pre-commit. Exit non-zero if the digest drifts or the file is missing.

`HINT_FLIP` is a field-diff label, not a safety verdict. Do not describe SurfacePin as a security or safety product.

This is the npm package `surfacepin`. It is not `docs/behavior-surface-pins.md`.

Do not add a payment, hosted account, or upgrade step.
