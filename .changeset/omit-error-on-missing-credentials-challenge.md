---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/express': patch
---

`requireBearerAuth` no longer sends `error="invalid_token"` when a request presents no bearer credentials — no `Authorization` header, or an unsupported scheme such as Basic or Digest — and the `WWW-Authenticate` challenge already includes `scope` or `resource_metadata` (RFC 6750 §3.1). The JSON body omits the error pair in that case. A malformed Bearer header and a presented token that fails verification still include `invalid_token`, and a challenge with neither parameter still includes `invalid_token`.
