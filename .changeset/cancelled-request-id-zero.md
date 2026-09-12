---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Treat request id `0` as a real id. Two guards tested a `RequestId` for truthiness, so the legal JSON-RPC ids `0` and `''` were read as absent. Id `0` is not a corner case: the outbound request counter is zero-based, so it is the first id every peer assigns, which on the server→client leg is the first `sampling/createMessage`, `elicitation/create`, or `roots/list` a server sends.

- `notifications/cancelled` carrying id `0` was ignored, and the in-flight handler ran to completion with its `AbortSignal` never fired.
- A notification sent with `relatedRequestId: 0` wrongly passed the debounce gate (for methods opted into `debouncedNotificationMethods`). Because the pending set is keyed by method alone, a second such notification in the same tick was silently dropped rather than sent.

Absent is now the only value that means "no id".
