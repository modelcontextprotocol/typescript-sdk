---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/client': minor
---

`Client.listen(filter)` opens a `subscriptions/listen` stream on a 2026-07-28-era connection, resolving once the server's acknowledged notification arrives with an `McpSubscription { honoredFilter, close() }`. Change notifications delivered on the stream dispatch to the existing `setNotificationHandler` registrations — the same handlers the 2025-era unsolicited notifications fire on a legacy connection — so `listen()` is era-transparent for consumers that already register those. `close()` closes the listen request's SSE stream (Streamable HTTP) or sends `notifications/cancelled` referencing the listen id (stdio); no automatic re-listen. On a 2025-era connection `listen()` throws a typed `MethodNotSupportedByProtocolVersion` steering to `resources/subscribe` and `ClientOptions.listChanged`. `ClientOptions.listChanged` now auto-opens a listen stream on a modern connection (filter derived from which sub-options were set; the auto-opened subscription is exposed at `client.autoOpenedSubscription`). `TransportSendOptions` gains `requestSignal` for per-request abort on the Streamable HTTP transport.
