---
'@modelcontextprotocol/client': patch
---

`StreamableHTTPClientTransport` no longer drops the resumption token when a resumed SSE stream disconnects before delivering any id-bearing event. `_handleSseStream()` tracked the latest event id in a local variable that always started `undefined`, instead of being seeded from the `resumptionToken` the stream was (re)opened with. A stream resumed with `Last-Event-ID: e1` that disconnected again before any new event arrived (load-balancer idle timeout, server restart) would therefore schedule its reconnect GET with no `Last-Event-ID` header at all, so the server treated it as a brand-new stream instead of a resumption — missed events were never replayed. The tracker is now seeded from `options.resumptionToken`, so a reconnect that saw no new events re-sends the same token instead of silently losing it.
