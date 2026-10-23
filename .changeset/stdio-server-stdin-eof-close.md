---
'@modelcontextprotocol/sdk': patch
---

`StdioServerTransport` now closes itself and fires `onclose` when its stdin ends or closes, so a server whose client hangs up tears down through `onclose` and can exit, instead of running on with no parent. A stdin that had already ended or been destroyed before `start()` is
treated the same way. `close()` is idempotent, so `onclose` fires once when `close()` is also called. Requests still in flight when stdin ends are aborted and not answered, and a notification sent after that rejects with `Not connected`; a client that expects responses keeps
stdin open until it has read them. An `onclose` that calls `process.exit()` can cut off output that is still being written.
