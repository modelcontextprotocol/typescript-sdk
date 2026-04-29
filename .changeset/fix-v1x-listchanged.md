---
'@modelcontextprotocol/server': patch
---

Fix: Disable listChanged capability in V1x protocol mode. V1x protocol does not support the listChanged capability, but it was being advertised by default. Now the server strips listChanged from tools, resources, and prompts capabilities when the negotiated protocol version is V1x (2024-11-05 or 2024-10-07).
