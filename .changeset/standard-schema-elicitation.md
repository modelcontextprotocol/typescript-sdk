---
'@modelcontextprotocol/core-internal': minor
'@modelcontextprotocol/server': minor
---

Allow `inputRequired.elicit()` to accept a Standard Schema such as a Zod object for `requestedSchema`. The builder converts it to MCP's restricted form-elicitation JSON Schema, while the same schema can validate and type the response through `acceptedContent()` on handler re-entry.
