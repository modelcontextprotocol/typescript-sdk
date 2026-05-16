---
'@modelcontextprotocol/server': minor
---

Pass `ServerContext` as the third argument to prompt and resource template completion callbacks.

This lets completion providers read request auth metadata from `ctx.http?.authInfo` and observe cancellation through `ctx.mcpReq.signal`, matching the context already available to tools, prompts, and resource callbacks.
