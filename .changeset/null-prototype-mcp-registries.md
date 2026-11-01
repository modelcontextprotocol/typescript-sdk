---
'@modelcontextprotocol/server': patch
---

McpServer tool/prompt/resource registries now use null-prototype objects so names inherited from `Object.prototype` (`constructor`, `toString`, `__proto__`, …) can be registered, listed, and called like any other name.
