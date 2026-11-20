---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/server': patch
---

Align `UriTemplate.expand()` value encoding with RFC 6570 section 3.2.1: percent-encode `!'()*` in strict variable expansions (`{var}`, `{?q}`, `{&q}`, `{.var}`, `{/var}`) and preserve valid existing `%HH` triplets in reserved (`+`) and fragment (`#`) expansions while still encoding lone or malformed `%` sequences.
