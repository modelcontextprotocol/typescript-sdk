---
'@modelcontextprotocol/client': patch
---

Bound standby SSE reconnects when the server keeps idle-closing the stream. `StreamableHTTPClientTransport` reset its reconnection attempt count to `0` every time a stream ended, so a server that gracefully idle-closes the standby GET/SSE stream (spec-compliant behavior) kept the client reconnecting forever at `initialReconnectionDelay` — `maxRetries` never tripped, and every cycle re-ran the authenticated fetch path.

The attempt count now persists across connect-then-close cycles that deliver no messages: after `maxRetries` consecutive fruitless reconnects the transport stops and surfaces `onerror` ("Maximum reconnection attempts exceeded"), exactly as it already did for reconnects that fail outright. A stream that delivers a message still resets the count, so healthy long-lived streams reconnect indefinitely as before.
