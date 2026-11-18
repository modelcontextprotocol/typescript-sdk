---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/client': patch
---

Accept RFC 8414 authorization-server metadata without an authorization endpoint for client-credentials-only servers, while producing a clear error if an authorization-code flow is attempted without an endpoint.
