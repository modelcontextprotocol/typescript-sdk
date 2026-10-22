---
'@modelcontextprotocol/server': patch
---

`Server.createMessage()` (and `ctx.mcpReq.requestSampling()`, which calls it) now refuses `includeContext: 'thisServer'` or `'allServers'` when the client did not declare the `sampling.context` capability, throwing `SdkError` with `SdkErrorCode.CapabilityNotSupported` before anything is sent, as it already does for `tools` without `sampling.tools`. The 2025-11-25 spec says servers SHOULD only use these values when the client declares `sampling.context`. A server that sends them to such a client must now omit `includeContext` or use `'none'`. Connections negotiated at a revision before 2025-11-25, which has no `sampling.context` capability, are unaffected.
