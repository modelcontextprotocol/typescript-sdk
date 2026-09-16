---
'@modelcontextprotocol/client': patch
---

Drain piped stdio stderr so an unread `stderr: 'pipe'` stream cannot fill and deadlock the session. Listeners attached before `start()` / `connect()` still receive every chunk. Fixes #2776.
