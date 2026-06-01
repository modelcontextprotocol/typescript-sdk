---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/server': patch
---

Request handlers can now read the protocol version governing the current request from their context (`ctx.mcpReq.protocolVersion`, both client and server handlers), and server handlers can read the calling client's declared capabilities and implementation info
(`ctx.client.capabilities`, `ctx.client.info`). `getNegotiatedProtocolVersion()` is now declared on `Protocol`, so both roles expose it.
