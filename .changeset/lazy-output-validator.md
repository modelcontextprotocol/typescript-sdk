---
'@modelcontextprotocol/client': patch
---

`Client.callTool` compiles the output-schema validator for the named tool only. A cached `tools/list` catalog stays complete, and a changed list, eviction, header mismatch, or reconnect drops that validator instead of reusing it. Tools that are not called are not compiled.
