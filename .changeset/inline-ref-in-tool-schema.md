---
'@modelcontextprotocol/core': patch
---

Inline local `$ref` pointers in tool `inputSchema` before returning from `schemaToJson()`. LLMs cannot resolve JSON Schema `$ref` and serialize referenced parameters as strings instead of objects. This ensures tool schemas are self-contained and LLM-consumable.
