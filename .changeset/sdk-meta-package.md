---
'@modelcontextprotocol/sdk': patch
---

Add `@modelcontextprotocol/sdk` meta-package: re-exports `@modelcontextprotocol/server` + `client` + `node` and preserves v1 deep-import subpaths (`/types.js`, `/server/mcp.js`, `/client/index.js`, `/shared/transport.js`, `/server/auth/errors.js`, etc.). The package is the recommended primary entry point; the split packages remain available for bundle-conscious consumers.
