---
'@modelcontextprotocol/core': patch
---

Fix `UriTemplate.match()` to correctly handle optional query parameters per RFC 6570. Templates using `{?param1,param2}` now match URIs with no query params, a subset of params, or params in a different order than declared in the template.
