---
'@modelcontextprotocol/client': patch
---

Accumulate OAuth scopes across 401/403 responses for progressive authorization. When an MCP server returns a 401 or 403 with a new required scope, the client now merges the new scope into the existing set rather than replacing it, preventing authorization loops where gaining one scope loses another.
