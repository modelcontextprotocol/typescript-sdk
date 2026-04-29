---
'@modelcontextprotocol/client': patch
---

Allow `StreamableHTTPClientTransport` and `SSEClientTransport` to restart after `close()`. `close()` now clears `_abortController` (previously aborted but not unset, blocking the start guard) and `_sessionId` (previously leaked into post-restart requests, causing 404s).
