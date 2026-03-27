---
'@modelcontextprotocol/client': patch
---

Deduplicate concurrent OAuth refreshes for the same provider, authorization server, resource, and refresh token so parallel `auth()` callers reuse the in-flight refresh instead of replaying a rotating refresh token.
