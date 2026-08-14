---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Honor `notifications/cancelled` for request id `0`. The cancellation guard tested `requestId` for truthiness, so a cancel carrying the legal JSON-RPC id `0` — or the empty string — was treated as an absent id and the in-flight handler ran to completion with its `AbortSignal` never fired. Id `0` is not a corner case: the outbound request counter is zero-based, so it is the first id every peer assigns, which on the server→client leg is the first `sampling/createMessage`, `elicitation/create`, or `roots/list` a server sends. Absent is now the only value that means "no id".
