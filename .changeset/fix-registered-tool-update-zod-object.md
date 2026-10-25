---
'@modelcontextprotocol/sdk': patch
---

Fix `RegisteredTool.update` crash when given a Zod object schema. The update path now uses the same `getZodSchemaObject` helper as `_createRegisteredTool` so both paths handle `ZodObject` inputs cleanly. Resolves #1960.
