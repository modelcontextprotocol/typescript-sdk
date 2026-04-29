---
"@modelcontextprotocol/server": patch
---

Fix `registerPrompt` generic to allow the no-args callback overload. The `Args` type parameter now defaults to `undefined`, matching `registerTool`.
