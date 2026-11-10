---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/server': patch
---

Publish `RequestMetaEnvelope` with its wire keys intact, so `ctx.mcpReq.envelope?.[CLIENT_CAPABILITIES_META_KEY]` is typed as `ClientCapabilities | undefined`. The 2.4.0 declaration emit dropped the computed keys and published the type as `{}`.
