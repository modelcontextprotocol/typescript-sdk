---
'@modelcontextprotocol/codemod': patch
---

The `v1-to-v2` codemod now rewrites imports, re-exports and mocks of the bare barrel subpaths `@modelcontextprotocol/sdk/client`, `@modelcontextprotocol/sdk/server` and `@modelcontextprotocol/sdk/validation` the same way as their `/index.js` forms. Before, they were left in place with an `Unknown SDK import path` marker.
