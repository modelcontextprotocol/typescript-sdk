---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Fixed a bug where a notification's `relatedRequestId: 0` was treated as absent by the debounce guard in `Protocol.notification()`, because the check used truthiness instead of testing for presence. `0` is a valid JSON-RPC request id — and the first id a `Protocol` instance issues — so a notification tied to request `0` could be silently coalesced by the debounce path even though related notifications are supposed to bypass debouncing.
