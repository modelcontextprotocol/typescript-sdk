---
'@modelcontextprotocol/client': patch
---

Deduplicate concurrent OAuth refresh flows for the same provider. Parallel 401 handlers now
share one in-flight refresh instead of redeeming the same rotating refresh token multiple times.
Authorization-code exchanges and forced reauthorization bypass deduplication because they carry
distinct, one-time authorization state.
