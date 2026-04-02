---
'@modelcontextprotocol/examples-server': patch
---

Example servers now return HTTP 404 (not 400) when a request includes an unknown session ID, so clients can correctly detect they need to start a new session. Requests missing a session ID entirely still return 400.
