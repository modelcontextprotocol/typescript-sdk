---
"@modelcontextprotocol/codemod": patch
---

The v1→v2 codemod now infers whether a project is client, server, or both by scanning the source for `@modelcontextprotocol/sdk/client/` and `.../server/` imports when the split v2 dependencies are not yet present in `package.json`. A v1 project (single `@modelcontextprotocol/sdk` dependency) previously resolved to `unknown`, so every file importing only shared protocol types defaulted to `@modelcontextprotocol/server` with an action-required warning. Now a project that uses both client and server APIs is detected as `both` and resolves shared types to the server package with an informational note (both packages re-export them); a client-only or server-only project routes shared types to the package it actually installs.
