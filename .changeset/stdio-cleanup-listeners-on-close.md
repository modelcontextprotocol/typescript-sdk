---
'@modelcontextprotocol/client': patch
---

Detach stdio transport stdout/stdin listeners on `close()`. Previously, if the child process wrote to stdout during shutdown (after `close()` was called), the still-attached data listener would attempt to parse it as JSON-RPC and emit a spurious parse error via `onerror`. Fixes #780.
