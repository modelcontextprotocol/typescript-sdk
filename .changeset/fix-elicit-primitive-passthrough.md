---
'@modelcontextprotocol/core': patch
---

Allow extra JSON Schema keywords on elicitation primitive schemas (`string`, `number`, `boolean`).

Previously, `BooleanSchemaSchema`, `StringSchemaSchema`, and `NumberSchemaSchema` used strict Zod parsing, so any keyword not explicitly listed (e.g., `pattern`, `exclusiveMinimum`, `exclusiveMaximum`, `const`) caused the schema to be rejected. This broke real-world use cases where servers send valid JSON Schema with standard annotation or validation keywords.

The fix adds `.passthrough()` to each primitive schema so that extra keys are preserved instead of stripped. The corresponding `BooleanSchema`, `StringSchema`, and `NumberSchema` TypeScript interfaces also gain `[key: string]: unknown` index signatures to stay in sync.
