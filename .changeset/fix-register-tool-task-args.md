---
'@modelcontextprotocol/server': patch
---

Fix `registerToolTask` to pass empty args object to `createTask` handler when no `inputSchema` is provided, allowing two-argument `(args, ctx)` handler signatures to work correctly.
