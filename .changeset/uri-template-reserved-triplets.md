---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Preserve existing percent-encoded triplets in reserved and fragment URI template variable expansions instead of percent-encoding them again, while continuing to encode ordinary percent signs.
