---
'@modelcontextprotocol/core': patch
---

Inline local `$ref` pointers in tool `inputSchema` so schemas are self-contained and LLM-consumable. LLMs cannot resolve JSON Schema `$ref` — they serialize referenced parameters as strings instead of objects. Recursive schemas now throw at `tools/list` time instead of silently degrading.
