---
'@modelcontextprotocol/server': patch
---

`serveStdio`: a notification without `_meta` (such as a late `notifications/cancelled` for the probe) received after a `server/discover` probe no longer pins the connection to the 2025 era. It is delivered to the probe instance, so later enveloped requests are still served as 2026-07-28 and a fallback `initialize` still selects the 2025 era.
