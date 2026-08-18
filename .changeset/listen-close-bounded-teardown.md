---
'@modelcontextprotocol/client': patch
---

Bound the wait in `McpSubscription.close()`. It serially awaited the `notifications/cancelled` teardown send, so a transport send that never settles (e.g. a stdio write parked on `'drain'`, which ignores `requestSignal`) left `await sub.close()` hanging forever. `close()` still waits for the notification so it is on the wire when it resolves on healthy transports, but the wait is now capped (5s); the subscription's state machine settles immediately either way.
