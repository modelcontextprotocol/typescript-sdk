---
'@modelcontextprotocol/core': patch
---

Preserve `relatedRequestId: 0` when deciding whether notifications can be debounced. Request id `0` is valid, so request-associated notifications with that id now bypass debounce like other related notifications.
