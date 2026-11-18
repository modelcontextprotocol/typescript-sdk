---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/server': patch
---

Support the RFC 6570 path-style parameter operator (`;`) in URI templates: templates such as `{;x,y}` now expand to `;x=1;y=2` (and `;name` when the value is empty), and `UriTemplate#match` parses those segments back into variables. Also treat a list with zero members as undefined, as RFC 6570 allows, so `/tags{/tags}`, `/tags{?tags}`, `X{.tags}` and `X{;tags}` no longer leave a dangling separator or an empty `name=` pair when the list is empty.

Known limitation: an exploded `;` list with exactly one member expands to `;list=red` and matches back as the string `'red'`, not `['red']`; a zero-member list expands to nothing and therefore does not match. Both come from the existing `string | string[]` `Variables` type and the `+` in the repeated pattern, not from this change.
