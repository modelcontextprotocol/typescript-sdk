---
'@modelcontextprotocol/client': patch
---

Preserve the resumption token across a resumed SSE stream that drops before any
id-bearing event arrives. `StreamableHTTPClientTransport._handleSseStream()` tracked the
latest event id in a local that started as `undefined` and was never seeded from the
`resumptionToken` the stream was opened with, yet both reconnect paths forwarded that
local as the next attempt's token. A stream resumed with `Last-Event-ID: e1` that closed
again before replaying any event — a load-balancer idle timeout, a server restart — was
therefore reconnected with no `Last-Event-ID` header at all. The server treated that as a
brand-new stream, missed events were never replayed, and a long-running request hung
until its timeout.

The tracker is now seeded from the incoming `resumptionToken`, so a reconnect that saw no
new events re-sends the same cursor. Replay from an already-seen cursor is idempotent,
and a newer event id still overrides the seed as soon as one arrives. `onresumptiontoken`
is unchanged: it fires only for ids actually received on the wire, not for the seed.

Fixes #2499.
