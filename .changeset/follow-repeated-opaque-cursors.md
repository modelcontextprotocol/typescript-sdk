---
'@modelcontextprotocol/client': patch
---

`listTools()` / `listPrompts()` / `listResources()` / `listResourceTemplates()` no longer stop their auto-aggregate walk when a server repeats a cursor. Cursors are opaque — a server keeping its pagination position server side may legally return the same token for every page — so the walk now ends only when a page carries no `nextCursor`, and `listMaxPages` remains the loud non-convergence guard (it throws `ListPaginationExceeded` instead of returning a truncated aggregate that looks complete).
