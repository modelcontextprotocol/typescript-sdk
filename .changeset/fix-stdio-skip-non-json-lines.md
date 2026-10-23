---
'@modelcontextprotocol/sdk': patch
---

Skip non-JSON lines in the stdio `ReadBuffer` instead of surfacing a `SyntaxError` via `onerror` (e.g. a server logging "Shutting down..." to stdout on close). Valid JSON that fails schema validation still throws. Backport of #1762.
