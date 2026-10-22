---
'@modelcontextprotocol/client': patch
---

Discard asynchronous cache reads when their logical key is invalidated while the read is pending, so a delayed cache hit cannot return a stale result or restore stale tool metadata after a change notification.
