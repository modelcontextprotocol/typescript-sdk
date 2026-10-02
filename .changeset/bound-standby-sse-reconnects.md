---
'@modelcontextprotocol/client': patch
---

Bound standby SSE reconnects when the server rapidly idle-closes the stream. `StreamableHTTPClientTransport` reset its reconnection attempt count to `0` every time a stream ended, so a server that gracefully idle-closes the standby GET/SSE stream immediately after every reconnect (spec-compliant behavior) kept the client reconnecting forever at `initialReconnectionDelay` — `maxRetries` never tripped, and every cycle re-ran the authenticated fetch path.

The attempt count now persists across connect-then-close cycles that make no progress: after `maxRetries` consecutive fruitless reconnects the transport stops and surfaces `onerror` ("Maximum reconnection attempts exceeded"), exactly as it already did for reconnects that fail outright. A stream counts as having made progress — and resets the count — when it delivers a message or stays open for at least `maxReconnectionDelay`, so healthy sessions whose idle standby stream is periodically closed by the server or an intermediary keep reconnecting indefinitely as before.

Also fixed in the same path: a reconnected stream that ended before any event arrived no longer drops the `Last-Event-ID` resumption token it was opened with — the next attempt resumes from the same token instead of silently starting a fresh stream.
