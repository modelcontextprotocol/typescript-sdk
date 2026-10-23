---
'@modelcontextprotocol/server': patch
---

`createMcpHandler` now sends `Allow: POST` on every `405` it answers to a non-POST request, with `legacy: 'stateless'` (the default) and with `legacy: 'reject'`.
