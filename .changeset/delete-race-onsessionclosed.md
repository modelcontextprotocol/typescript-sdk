---
'@modelcontextprotocol/server': patch
---

Fire `onsessionclosed` at most once when DELETE requests for the same session overlap. The first DELETE awaited the callback before `close()` ran, so `_closed` was still `false` and a second DELETE passed the same guards and invoked the callback again for a session already being torn down. The notification is now claimed synchronously before the await. DELETE remains idempotent — a concurrent or repeat request still terminates the session and answers 200.
