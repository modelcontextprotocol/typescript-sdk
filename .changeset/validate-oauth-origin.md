---
'@modelcontextprotocol/client': patch
---

Validate target origin before attaching OAuth bearer tokens in `withOAuth` (RFC 6750 §5.3). Tokens are now only attached to requests targeting the configured `baseUrl` origin, preventing cross-origin token disclosure.
