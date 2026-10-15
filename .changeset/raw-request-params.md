---
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/client': minor
---

Add the opt-in `includeRawRequestParams` protocol option, exposing original inbound request params through `ctx.mcpReq.rawParams` before wire-field lifting and schema parsing. Default validation and parsed handler arguments remain unchanged. Raw values are untrusted and must be validated separately by applications that need compatibility with non-standard request extensions.
