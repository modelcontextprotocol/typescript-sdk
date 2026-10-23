---
'@modelcontextprotocol/sdk': patch
---

Fix the advertised root package export failing with `ERR_MODULE_NOT_FOUND`. `package.json` maps the `.` export to `dist/{esm,cjs}/index.{js,d.ts}`, but there was no `src/index.ts`, so `tsc` never emitted those files and they were absent from the published tarball — both
`import '@modelcontextprotocol/sdk'` and `require('@modelcontextprotocol/sdk')` threw before consumer code ran. Adds a side-effect-free `src/index.ts` re-exporting the shared protocol surface (`./types.js`) and the in-memory transport (`./inMemory.js`); `Client` and `Server`
remain on their `./client` / `./server` subpath exports to avoid ambiguous re-export collisions. Subpath imports are unchanged.
