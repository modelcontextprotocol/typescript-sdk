---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Keep response IDs and progress tokens distinct by JSON type. String values such as `"0"` and `""` no longer match an outstanding request or progress callback registered with numeric ID `0`; unmatched messages are reported through the existing error handler.
