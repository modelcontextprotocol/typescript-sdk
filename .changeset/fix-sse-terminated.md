---
"@modelcontextprotocol/client": patch
---

Fix SSE stream graceful termination being incorrectly reported as an error. When a server closes an SSE connection gracefully (e.g., due to timeout), the client no longer reports "TypeError: terminated" via onerror. This reduces log noise while preserving reconnection behavior.
