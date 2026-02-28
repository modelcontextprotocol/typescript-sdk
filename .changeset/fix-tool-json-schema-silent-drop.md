---
'@modelcontextprotocol/sdk': patch
---

Detect and throw a descriptive error when a raw JSON Schema object is passed to `server.tool()` instead of a Zod schema, preventing silent schema loss where the JSON Schema was misclassified as `ToolAnnotations`.
