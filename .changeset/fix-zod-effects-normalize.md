---
'@modelcontextprotocol/sdk': patch
---

Handle ZodEffects wrappers (`.superRefine()`, `.refine()`, `.transform()`) in `normalizeObjectSchema()` and `getObjectShape()`. Previously, schemas wrapped with these methods would fall back to `EMPTY_OBJECT_JSON_SCHEMA` in `tools/list` responses because `normalizeObjectSchema()`
only checked for `.shape` (v3) or `_zod.def.shape` (v4), which ZodEffects/pipe types lack. The fix walks through the wrapper chain to find the inner ZodObject, ensuring correct JSON Schema generation for tool listings.
