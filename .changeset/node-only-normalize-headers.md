---
'@modelcontextprotocol/sdk': patch
---

Avoid referencing the DOM-only `HeadersInit` global in emitted transport declarations so Node-only TypeScript projects can compile with `skipLibCheck: false`.
