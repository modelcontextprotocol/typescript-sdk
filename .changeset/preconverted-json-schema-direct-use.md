---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/server': patch
---

A schema passed to `registerTool` / `registerPrompt` that is itself an already-converted JSON Schema document — e.g. the output of zod's `toJSONSchema()`, which retains a `~standard` prop — is now used directly instead of being re-converted through the original schema's converters on every `tools/list` and `toolInputSchemaJson()` call.

The same direct use applies to an elicitation `requestedSchema`: a document carrying root-level constraints elicitation does not support (e.g. `additionalProperties`) now fails with the documented unsupported-constraint error — the same treatment a raw JSON Schema already receives — where the previous re-conversion silently dropped them.
