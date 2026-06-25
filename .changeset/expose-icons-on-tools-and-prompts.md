---
'@modelcontextprotocol/server': minor
---

Support `icons` on the high-level `McpServer.registerTool()` and `registerPrompt()` config objects (and on their `update()` methods). Tool and prompt icons now surface in `tools/list` and `prompts/list`. Resource, resource-template, and server-info (`Implementation`) icons already passed through. This closes the gap with the MCP spec, which allows `icons` on tools, resources, resource templates, and prompts.
