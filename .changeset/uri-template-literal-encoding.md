---
'@modelcontextprotocol/core-internal': patch
---

Pct-encode URI template literals per RFC 6570 §3.1, so a resource template whose literal text carries a character the URI grammar does not allow stays routable.

`UriTemplate` copied literal runs verbatim, in both `expand()` and the pattern `match()` builds. §3.1 requires a literal outside the reserved/unreserved sets — `ucschar` (`café`), a space — to be pct-encoded as UTF-8 on expansion, so `expand()` returned a string that is not a valid RFC 3986 URI.

The consequence was a resource that could be listed but never read. `resources/read` resolves the requested URI through `new URL()`, which pct-encodes it, and the raw literal in the pattern could not match that: a template such as `file:///docs/café/{name}` answered `-32602 Resource not found` for every URI a client could send, encoded or not.

Literals are now encoded in both directions, with existing `%XX` triplets passing through unchanged so an already-encoded literal is not encoded twice.
