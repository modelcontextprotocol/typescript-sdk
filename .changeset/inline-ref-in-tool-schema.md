---
'@modelcontextprotocol/core': patch
---

Inline local `$ref` pointers in tool `inputSchema` so schemas are self-contained and LLM-consumable. LLMs cannot resolve JSON Schema `$ref` — they serialize referenced parameters as strings instead of objects. Recursive schemas are handled gracefully — cyclic `$ref` pointers are left in place with only their `$defs` entries preserved, while all non-cyclic refs are fully inlined.
