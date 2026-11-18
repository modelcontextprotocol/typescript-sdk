---
'@modelcontextprotocol/server': patch
---

`serveStdio` now completes a `subscriptions/listen` subscription right after the acknowledgement when none of the requested notification types are honored, matching `createMcpHandler`. The client receives the acknowledgement followed by the `resultType: "complete"` result, and no subscription slot is held.
