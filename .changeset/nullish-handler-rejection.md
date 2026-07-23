---
'@modelcontextprotocol/core': patch
---

A request handler that rejects with a nullish reason (a bare `reject()` or `throw null`) no longer strands the peer without a reply. `Protocol`'s inbound-request error path indexed `error['code']` directly, which throws a `TypeError` when the rejection reason is `null`/`undefined`; that throw propagated to the outer `.catch`, so no JSON-RPC error response was ever sent and the requester hung until its own timeout. The reason is now coalesced to a safe object before the error code and message are read, so a `-32603` (Internal error) response is always returned.
