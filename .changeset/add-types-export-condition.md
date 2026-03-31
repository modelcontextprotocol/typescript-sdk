---
'@modelcontextprotocol/sdk': patch
---

Add `"types"` condition to `exports` map for subpath imports (`.`, `./client`, `./server`, `./*`), enabling TypeScript to resolve type declarations with `moduleResolution: "bundler"` or `"node16"` without requiring manual `tsconfig.json` `paths` workarounds.
