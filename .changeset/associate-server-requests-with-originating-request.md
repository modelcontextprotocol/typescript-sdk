---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/node': patch
---

Server-to-client requests made from a tool handler (`ctx.mcpReq.elicitInput()`, `ctx.mcpReq.requestSampling()`) are now associated with the originating request and delivered on its SSE response stream, instead of the standalone GET stream (SEP-2260). When that stream cannot carry
SSE — `enableJsonResponse: true`, or the stream has closed — the call fails with a clear error instead of being silently dropped or delivered unassociated. Also adds an opt-in `keepAliveInterval` option to the streamable HTTP server transport, which writes periodic SSE keepalive
comments so proxies and load balancers do not drop idle connections during long-running requests.
