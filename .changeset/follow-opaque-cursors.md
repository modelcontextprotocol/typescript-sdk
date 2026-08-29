---
'@modelcontextprotocol/client': patch
---

Follow repeated opaque cursors during automatic list pagination until the configured `listMaxPages` limit or server termination, instead of silently truncating results based on cursor values.
