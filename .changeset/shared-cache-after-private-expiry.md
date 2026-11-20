---
'@modelcontextprotocol/client': patch
---

Use a held public cache entry after a private entry expires, so shared-store clients can reuse its response and tool metadata without an unnecessary request. Fresh private entries still take precedence, and stale private metadata remains available when no public entry is held.
