---
'@modelcontextprotocol/client': patch
---

OAuth well-known metadata discovery now falls back from a path-inserted URL to the root well-known document on any 4xx (not only 404), and builds that fallback on the authorization-server origin instead of the resource host (#2783, #2784).
