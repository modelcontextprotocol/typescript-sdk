---
'@modelcontextprotocol/client': patch
---

`listTools()`, `listPrompts()`, `listResources()` and `listResourceTemplates()` called without a cursor now follow `nextCursor` until the server stops sending one, instead of stopping silently with a short list when a cursor repeats; a page that has the same items and the same `nextCursor` as the page before it ends the walk and is not added twice, and `listMaxPages` still caps the walk.
