---
'@modelcontextprotocol/sdk': patch
---

`StdioServerTransport` now closes itself and fires `onclose` when its stdin ends or closes, so a server whose client hangs up tears down through `onclose` and can exit, instead of running on with no parent. A stdin that had already ended or been destroyed before `start()` is
treated the same way. `close()` is idempotent, so `onclose` fires once when `close()` is also called. Requests still in flight when stdin ends are aborted and not answered.
