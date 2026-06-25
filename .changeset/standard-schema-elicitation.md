---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/server': minor
---

Allow form elicitation requests to accept Standard Schema values such as Zod objects for `requestedSchema`. The server converts these schemas to MCP's restricted elicitation JSON Schema before sending and parses accepted content with the original schema before returning typed
results.
