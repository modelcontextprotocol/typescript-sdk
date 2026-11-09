---
'@modelcontextprotocol/server': patch
---

`subscriptions/listen` no longer registers an `abort` listener on the request signal when the stream has already completed. A filter narrowed to nothing is torn down inside the stream's `start()`, and teardown short-circuits once the subscription is closed, so the listener was never removed — not by the request, and not by `closeAll()`. Repeated completed listens on one live signal (a shared per-connection signal, for instance) accumulated one listener per request.
