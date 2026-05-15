---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/core': patch
---

Fix: accumulate OAuth scopes on 401/403 instead of overwriting

When an HTTP transport receives a 401 or 403 with a `WWW-Authenticate` header containing new scopes, the scopes are now merged with any previously-acquired scopes rather than replacing them. The previous behaviour could cause an infinite re-auth loop where the client repeatedly
lost its original scopes each time it attempted to upscope.
