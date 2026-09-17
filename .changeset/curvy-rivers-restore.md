---
'@modelcontextprotocol/server': patch
---

Restore a reused server's original `onclose` handler after each modern exchange so repeated requests do not accumulate nested handlers.
