---
'@modelcontextprotocol/sdk': patch
---

Validate each `callTool()` result against the output schema cached when the call begins, so a concurrent tool-list refresh cannot apply a newer schema to an in-flight result.
