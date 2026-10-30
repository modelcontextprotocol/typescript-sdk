---
'@modelcontextprotocol/core-internal': patch
---

`UriTemplate.match()` now percent-decodes every value it extracts from a URI, undoing the encoding that `expand()` applied for the same operator. `expand()` percent-encodes spaces, slashes, non-ASCII characters, and friends; `match()` was returning the still-encoded substring, so a handler routed through `ResourceTemplate` received the wrong string for any resource whose template variable contains a reserved or non-ASCII character.

- `decodeURIComponent` is used for the default, `.`, `/`, `?`, and `&` operators.
- `decodeURI` is used for `+` and `#`, matching the lighter `encodeURI` that `expand()` applies for those reserved-character operators.
- Each element of an exploded array is decoded independently.
- A malformed escape sequence (e.g. `%ZZ`) is returned unchanged rather than thrown, so a value that was already raw on the wire does not raise out of `match()`.
