---
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/client': minor
---

Add the opt-in `includeRawRequestParams` protocol option, exposing post-transport-parse request params through `ctx.mcpReq.rawParams` before wire-field lifting and handler parsing. Unknown siblings at the `tools/call` params level are preserved; nested objects such as `_meta` may already be normalized by transport schemas. Default validation and parsed handler arguments remain unchanged. Raw values are untrusted and must be validated separately by applications that need compatibility with non-standard request extensions.
