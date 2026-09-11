---
'@modelcontextprotocol/client': patch
---

`Client.request()` now accepts spec-conforming `skills/list`, `skills/get`, and `resources/directory/read` results whose caller schema still requires `resultType: "complete"`. The codec keeps lifting/stripping the discriminator; validation retries once with it restored so post-lift schemas that omit the field are unchanged. Fixes #2789.
