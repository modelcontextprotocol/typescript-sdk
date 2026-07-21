---
'@modelcontextprotocol/client': patch
---

Refresh cached protected-resource discovery when a fresh challenge supplies `resource_metadata`. When validated metadata selects a different authorization server, discard server-bound tokens and client credentials before reauthorization while preserving portable CIMD client IDs.
