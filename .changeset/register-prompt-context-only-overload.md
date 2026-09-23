---
'@modelcontextprotocol/server': patch
---

`McpServer.registerPrompt()` now type-checks the no-`argsSchema` form. When `config` carries no `argsSchema`, the prompt callback is invoked with the server context as its only argument, but both existing overloads constrained `Args` to a schema type, so the argument-less form resolved to the deprecated raw-shape signature and typed the parameter as the arguments record: reading `ctx.mcpReq` was a type error even though it works at runtime. A dedicated `argsSchema?: undefined` overload now types that callback as `PromptCallback`. Callbacks that take no parameters, and every schema-bearing form, are unchanged.
