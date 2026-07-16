---
'@modelcontextprotocol/server': minor
---

Add a high-level `aroundMcpRequest` interceptor for tool, resource, and prompt operations. The interceptor runs after routing and input validation and before output validation, result projection, cache hints, and protocol result processing.
