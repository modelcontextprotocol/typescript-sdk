---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/core-internal': patch
---

Validate the streamable HTTP Accept header by parsed media ranges (RFC 9110) instead of substring matching: legal wildcards like `*/*` and `application/*` are now accepted, and forged media types such as `application/jsonx` are rejected.
