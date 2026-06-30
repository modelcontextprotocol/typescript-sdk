---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/node': patch
---

Fix the published declaration files for consumers compiling with `skipLibCheck: false`: the bundled `.d.mts` no longer leaves a dangling `URIComponent` reference (ajv's published types import it from `fast-uri`, whose export-assigned namespace the dts bundler cannot link — the type is now inlined via a dts-only path mapping), and no longer imports `json-schema-typed` from an undeclared dependency (it is inlined via `dts.resolve`). `@modelcontextprotocol/node` drops a stale `typesVersions` entry pointing at a subpath that never shipped. Package READMEs note that TypeScript >=6.0 requires `"types": ["node"]` since the published declarations reference `Buffer`.
