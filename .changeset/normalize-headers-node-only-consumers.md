---
'@modelcontextprotocol/sdk': patch
---

Reference `RequestInit['headers']` instead of the bare global `HeadersInit` in `normalizeHeaders`.

`HeadersInit` is declared by the DOM lib only, while `RequestInit` is also provided globally by `@types/node` through `undici-types`. Consumers that compile the SDK with `"lib": ["ES2023"]`, `"types": ["node"]` and `"skipLibCheck": false` therefore failed with
`TS2304: Cannot find name 'HeadersInit'` on `dist/{esm,cjs}/shared/transport.d.ts`.

This matches the signature already used on `main`, and resolves the v1 line of the report.
