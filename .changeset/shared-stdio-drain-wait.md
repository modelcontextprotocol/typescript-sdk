---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Share a single 'drain' listener across concurrent backpressured stdio writes, fixing MaxListenersExceededWarning when many messages are written while the pipe is backed up (e.g. bulk `sendToolListChanged` notifications, or a slow-starting child process that isn't reading stdin yet). `StdioClientTransport.send()` now also rejects on stdin errors instead of waiting forever.
