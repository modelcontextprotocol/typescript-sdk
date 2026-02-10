---
'@modelcontextprotocol/node': patch
---

Add missing `hono` peer dependency to `@modelcontextprotocol/node`. The package already depends on `@hono/node-server` which requires `hono` at runtime, but `hono` was only listed in the workspace root, not as a peer dependency of the package itself.
