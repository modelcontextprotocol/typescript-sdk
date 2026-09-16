---
'@modelcontextprotocol/client': patch
---

Fix `Client.listen()` rejections escaping as process-level unhandled rejections. The internal `opening` promise could reject (ack timeout, transport close, server cancel, caller abort) while `listen()` was still serially awaiting `transport.send(...)`, so no rejection handler was attached yet — the rejection surfaced as an `unhandledRejection` that caller-side handling cannot prevent, and a send that never settles (e.g. a stdio write parked on `'drain'`) left `listen()` suspended forever even though the ack timer had already fired. `listen()` now suspends on the `opening` state machine directly and routes send failures into it, so every termination path rejects the returned promise and nothing escapes.
