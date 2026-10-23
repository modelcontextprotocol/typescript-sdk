---
'@modelcontextprotocol/sdk': patch
---

`McpServer` now accepts `registerTool()`, `registerResource()` and `registerPrompt()` after `connect()` when the capability was declared in the constructor options; before, the first registration after connecting threw `Cannot register capabilities after connecting to transport`.
A declared capability with nothing registered now answers its list request with an empty list instead of `Method not found`, and is advertised with `listChanged: true`, as it already was once anything had been registered.
