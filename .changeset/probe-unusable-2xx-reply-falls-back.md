---
'@modelcontextprotocol/client': patch
---

The version-negotiation probe no longer fails the connect when an intermediary
swallows the `server/discover` POST into an unusable 2xx. An empty or
whitespace JSON body, a bare `204`, or a media type the transport does not
accept previously rejected `connect()` with `EraNegotiationFailed`, while the
same endpoint answering `400` degraded gracefully to the legacy `initialize`
handshake — so a reverse proxy or API gateway in front of a working 2025 server
bricked the connection.

An HTTP layer that succeeded with an answer the client cannot use is now its
own probe outcome, classified like the unparseable-4xx row: a conservative
legacy fallback when one is available, and a typed `EraNegotiationFailed`
carrying the transport's failure as `cause` for a modern-only client or `pin`
mode. Genuine network failures (DNS, connection reset, CORS) keep their typed
error, and the auth and 5xx rows are unchanged.
