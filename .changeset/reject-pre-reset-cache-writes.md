---
'@modelcontextprotocol/client': patch
---

Reject pre-reset generation-0 cache writes after `resetForReconnect()` so a response whose generation snapshot was captured on a previous connection cannot populate the new connection's partition or overwrite a fresh post-reset cache entry.
