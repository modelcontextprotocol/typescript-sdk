---
'@modelcontextprotocol/sdk': patch
---

Fix the root package export: add `src/index.ts` so the advertised `dist/{esm,cjs}/index.js` and `dist/esm/index.d.ts` are actually emitted and published. The root entry re-exports the shared protocol types/schemas and the in-memory transport; `Client` and `Server` remain on their
`./client` and `./server` subpaths.
