---
'@modelcontextprotocol/client': patch
---

Reject pre-reset cache writes after `resetForReconnect()` by advancing a monotonic generation baseline on reset so a response whose generation snapshot was captured on a previous connection cannot populate the new connection's partition or overwrite a fresh post-reset cache entry.
