---
'@modelcontextprotocol/client': patch
---

Stop the legacy-era (2025-11-25) Streamable HTTP SSE reconnect chain when its originating request settles. Previously, when a request on a legacy session timed out or was aborted, the client POSTed `notifications/cancelled` but the transport kept resuming the request's SSE stream via GET + Last-Event-ID indefinitely (each successful resume reset the retry counter), and a late resumed response surfaced as "Received a response for an unknown message ID". The protocol layer now threads a request-scoped abort signal to per-request-stream transports on the legacy era too, and aborts it alongside the `notifications/cancelled` POST when the request settles — the wire-visible cancellation behavior is unchanged for every (era × transport) combination.
