---
'@modelcontextprotocol/core-internal': patch
---

Support RFC 6570 prefix modifiers (`:N`) in `UriTemplate`: retain clean variable names in `variableNames` and `match()`, and apply prefix truncation to Unicode code points before percent-encoding during expansion.
