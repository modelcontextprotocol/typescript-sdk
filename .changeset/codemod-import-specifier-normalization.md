---
"@modelcontextprotocol/codemod": patch
---

The v1→v2 codemod now normalizes import specifiers before the import-map lookup, so extensionless (`@modelcontextprotocol/sdk/types`) and directory-style (`@modelcontextprotocol/sdk/server`) specifiers resolve the same as their canonical `.js` form. Projects using bundler/node16 module resolution that imported SDK modules without the `.js` extension previously hit "Unknown SDK import path: ... Manual migration required" even though the `.js` twin was mapped; those now migrate automatically. Genuinely unknown subpaths still report.
