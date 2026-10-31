---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/express': patch
---

`requireBearerAuth` no longer sends `error="invalid_token"` when a request has no `Authorization` header and the `WWW-Authenticate` challenge already includes `scope` or `resource_metadata` (RFC 6750 §3.1). The JSON body omits the error pair in that case. A presented token that fails verification is unchanged, and a challenge with neither parameter still includes `invalid_token`.
