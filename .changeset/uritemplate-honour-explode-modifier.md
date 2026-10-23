---
'@modelcontextprotocol/core': patch
---

Honor the RFC 6570 explode modifier (`*`) in `UriTemplate.expand()`, and match what it emits: an exploded path part spans path segments and splits back into a list, an exploded query or form-continuation part repeats the name per value, and a plain part keeps the comma-joined value. A template such as `db://{/path*}` can now read back its own expansion, which `resources/read` previously answered with `ResourceNotFoundError`.
