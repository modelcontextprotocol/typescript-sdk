---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/server': patch
---

A URI template now percent-encodes `!`, `'`, `(`, `)` and `*` when it expands a value for a non-reserved operator, as RFC 6570 §3.2.1 requires. A value of `a!b` used with `{var}` expands to `a%21b` instead of `a!b`, matching every other RFC 6570 implementation. Reserved expansion (`{+var}` and `{#var}`) is unchanged: those characters are reserved there and stay literal. `match()` returns the raw matched span and is unaffected, so expansion and matching stay symmetric.
