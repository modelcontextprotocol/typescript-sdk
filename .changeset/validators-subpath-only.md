---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/node': patch
---

Fix two declaration-file issues for consumers compiling with `skipLibCheck: false`: the bundled `.d.mts` no longer leaves a dangling `URIComponent` reference (ajv's published types import it from `fast-uri`, whose `export =` namespace the dts bundler cannot destructure — the type is now inlined via a dts-only path mapping), and `@modelcontextprotocol/node` drops a stale `typesVersions` entry pointing at a subpath that no longer ships. Package READMEs note that TypeScript ≥6.0 requires `"types": ["node"]` since the published declarations reference `Buffer`.
