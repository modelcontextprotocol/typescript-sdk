---
'@modelcontextprotocol/server': patch
---

Enable completion handling when a prompt schema or resource template gains a completion callback through `update()` before connecting. Previously these updates left the server without the `completions` capability and `completion/complete` returned `Method not found`.

Adding the first completion callback after connecting now rejects the update before changing the registration, matching the existing restriction on adding new capabilities to a connected server.
