---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/server': patch
---

Support the RFC 6570 path-style parameter operator (`;`) in URI templates: templates such as `{;x,y}` now expand to `;x=1;y=2` (and `;name` when the value is empty), and `UriTemplate#match` parses those segments back into variables. Also treat a list with zero members as undefined, as RFC 6570 allows, so `/tags{/tags}`, `/tags{?tags}`, `X{.tags}` and `X{;tags}` no longer leave a dangling separator or an empty `name=` pair when the list is empty.
