---
'@modelcontextprotocol/server': patch
---

`subscriptions/listen` no longer registers an `abort` listener on the request signal once the stream has already completed. A filter honored down to nothing is torn down inside the stream's `start()`, and teardown short-circuits once `closed` is set, so the listener that wiring then added could never be removed — not by a later teardown, and not by `closeAll()`. Completed listens that share one still-live signal therefore accumulated a listener, and its subscription closure, per request.
