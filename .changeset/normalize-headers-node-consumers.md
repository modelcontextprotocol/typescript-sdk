---
'@modelcontextprotocol/sdk': patch
---

`normalizeHeaders` no longer references the DOM-only global `HeadersInit` in its published declaration. It now uses `RequestInit['headers']`, which `@types/node` binds globally, so Node-only consumers compiling with `skipLibCheck: false` and no `"DOM"` lib no longer fail with
`TS2304: Cannot find name 'HeadersInit'`. Fixes #2568
