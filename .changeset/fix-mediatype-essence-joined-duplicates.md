---
'@modelcontextprotocol/core-internal': patch
---

`mediaTypeEssence()` now yields no essence when an unparseable `Content-Type` value carries its joining comma in the media-type segment (for example `application/json, application/json`, as produced by joined duplicate headers), matching the documented contract and the parameter-tail behaviour. Previously such values returned the raw joined string as the essence. No call-site behaviour changes: every consumer compares the essence against a known media type, which the joined string already failed.
