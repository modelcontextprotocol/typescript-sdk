---
'@modelcontextprotocol/client': patch
---

Reject `server/discover` replies carrying an unrecognized `resultType` (`partial`, `input_required`, …) during version negotiation instead of treating them as modern-era evidence. A missing `resultType` still reads as `complete`, per the spec's backward-compatibility rule.
