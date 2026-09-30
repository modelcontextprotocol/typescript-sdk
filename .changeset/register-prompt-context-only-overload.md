---
'@modelcontextprotocol/server': patch
---

`McpServer.registerPrompt()` now types the callback correctly when no `argsSchema` is given: its one parameter is the server context. Before, reading `ctx.mcpReq` there was a type error although it worked at runtime. Prompts registered with an `argsSchema` are unchanged.
