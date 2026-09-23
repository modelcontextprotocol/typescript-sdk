---
'@modelcontextprotocol/server': patch
---

Check `registerTool` callback results against the inferred `outputSchema` type. Successful callbacks with an output schema must return matching, non-undefined `structuredContent`; error and input-required results remain supported. This catches incompatible output at compile time for Standard Schema providers and deprecated raw Zod shapes, while retaining runtime validation. Previously accepted callbacks that omit structured output or return the wrong type now produce a TypeScript error.
