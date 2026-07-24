---
'@modelcontextprotocol/sdk': patch
---

Hardens the Streamable HTTP server transport's SSE keep-alive lifecycle: keep-alive timers can no longer be armed after the transport closes or leak when a priming event write fails, and a non-finite `keepAliveMs` disables keep-alive instead of arming a clamped ~1ms interval.
