---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

`UriTemplate.match()` now returns `null` instead of throwing a `TypeError` when a template contains an empty expression (such as `{}` or `{,}`), and `expand()` no longer reads `variables['undefined']` for those expressions. `McpServer` resource reads against such a template now answer `-32602` (`Resource not found`) rather than leaking an internal error.
