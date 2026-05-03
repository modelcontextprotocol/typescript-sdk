---
'@modelcontextprotocol/core': patch
---

Remove `zod` from `dependencies` in `@modelcontextprotocol/core` and keep it only as a peer dependency to avoid duplicate installs that can cause TypeScript type incompatibilities.
