---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/server': minor
---

Allow form elicitation requests to accept Standard Schema values such as Zod objects for `requestedSchema`. The server converts these schemas to MCP's restricted elicitation JSON Schema before sending and parses accepted content with the original schema before returning typed
results. Zod string formats that map to MCP's supported `email`, `uri`, `date`, or `date-time` formats are accepted; arbitrary regex patterns remain rejected because form elicitation does not carry JSON Schema `pattern`.
