---
'@modelcontextprotocol/server': patch
---

Check AbortSignal in handleAutomaticTaskPolling to stop cancelled requests from polling indefinitely. Previously, if a client cancelled a tools/call request during automatic task polling, the poll loop continued consuming server resources until the task completed or the process died.
