---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

The `ajv` and `ajv-formats` copies bundled into `dist/` now resolve `fast-uri` 3.1.8 instead of 3.1.0, which carries nine published security advisories (all fixed in 3.1.8). Because those copies are inlined rather than declared as dependencies, downstream `overrides`/`resolutions` could not reach them and lockfile-based scanners could not see them; this patch ships the rebuilt `dist/`. No API, option, dependency or runtime behavior change.
