---
'@modelcontextprotocol/client': patch
---

Preserve `_meta` on `input_required` results. The 2026-07-28 decode seam rebuilt the payload from `inputRequests` and `requestState` only, so result-level metadata a server sent on an `input_required` result (including `io.modelcontextprotocol/serverInfo`) was dropped before an `allowInputRequired: true` caller could see it. `Result._meta` is a result-level field, so `input_required` carries it exactly like any other result.
