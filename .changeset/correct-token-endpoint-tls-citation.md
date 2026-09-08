---
'@modelcontextprotocol/client': patch
---

Correct the JSDoc for insecure OAuth token endpoints. The TLS requirement comes from the MCP authorization specification's OAuth 2.1 communication-security rules, not SEP-2207, which covers OIDC-flavored refresh-token guidance. Documentation only; no runtime behavior change.
