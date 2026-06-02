---
'@modelcontextprotocol/core': patch
---

Fix `notifications/cancelled` handling for request ID `0`. Previously the cancellation guard treated `0` as missing and left the first request from a protocol instance uncancellable.
