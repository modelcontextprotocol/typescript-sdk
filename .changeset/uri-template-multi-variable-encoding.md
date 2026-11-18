---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

`UriTemplate.expand()` now percent-encodes the values of multi-variable expressions. A template with two or more variables in one expression (`{x,y}`) interpolated its values raw, so a value carrying a space or a reserved character produced a malformed URI — `new UriTemplate('{x,y}').expand({ x: 'value with spaces', y: 'a/b?c&d' })` returned `value with spaces,a/b?c&d` instead of `value%20with%20spaces,a%2Fb%3Fc%26d`. Single-variable expressions already encoded correctly, so the defect only showed once a second variable was added to the same expression. Encoding is operator-aware, matching the single-variable path: `{+x,y}` and `{#x,y}` keep reserved characters and encode the rest.
