---
'@modelcontextprotocol/core': patch
---

Fix `UriTemplate.match()` to correctly handle optional, out-of-order, and URL-encoded query parameters. Previously, query parameters had to appear in the exact order specified in the template and omitted parameters would cause match failures. Omitted query parameters are now absent from the result (rather than set to `''`), so callers can use `vars.param ?? defaultValue`.
