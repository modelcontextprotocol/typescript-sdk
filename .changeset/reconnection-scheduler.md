---
'@modelcontextprotocol/client': minor
---

Add `reconnectionScheduler` option to `StreamableHTTPClientTransport`. Lets non-persistent environments (serverless, mobile, desktop sleep/wake) override the default `setTimeout`-based SSE reconnection scheduling. The scheduler may return a cancel function that is invoked on `transport.close()`.
