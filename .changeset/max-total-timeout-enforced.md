---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

`maxTotalTimeout` is now enforced as a hard cap. The pending timer is armed with whichever budget runs out first, the per-request `timeout` or what is left of `maxTotalTimeout`, and a progress reset re-arms it with the remaining total budget instead of the full `timeout`. A request that never receives a progress notification now rejects with `Maximum total timeout exceeded` at the cap rather than waiting out `timeout`.
