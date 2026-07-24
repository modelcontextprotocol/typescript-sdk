---
'@modelcontextprotocol/sdk': patch
---

Fix SSE keep-alive timer lifecycle in the Streamable HTTP server transport. Keep-alive timers are now owned by the stream they were armed for, so a stale disconnect arriving after a reconnect no longer stops the live stream's keep-alive, a resume closes the superseded stream
cleanly, and a failed priming-event write no longer leaves a timer running or a stale request correlation behind. A resume that completes after the transport closed now gets a 404 instead of a silent stream nothing will ever write to. Non-finite `keepAliveMs` values now disable
keep-alive, and values above 2^31-1 are clamped instead of firing every millisecond.
