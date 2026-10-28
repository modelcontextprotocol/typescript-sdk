---
'@modelcontextprotocol/node': patch
---

Test-only change: the node middleware SSE tests now accumulate a streamed response across multiple fetch chunks instead of assuming a complete event arrives in the first read, so chunked-delivery regressions fail the suite rather than passing intermittently. No runtime change.
