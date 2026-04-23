---
'@modelcontextprotocol/core': patch
---

Fix UriTemplate.match() to handle optional and out-of-order query parameters per RFC 6570. Templates like `{?param1,param2}` now correctly match URIs with no query params, a subset of params, or params in any order.
