---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Fix `resetTimeoutOnProgress` so it works without an `onprogress` handler. Requests that opt into timeout resets now advertise a progress token, reset their timeout when progress arrives, and no longer report progress for the known in-flight request as an unknown-token error.
