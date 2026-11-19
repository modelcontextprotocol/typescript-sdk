---
'@modelcontextprotocol/server': patch
---

The standalone `GET` SSE stream now starts with a priming event (an event ID, plus `retry` when `retryInterval` is set), as POST streams already do. It is sent when an `eventStore` is configured and the request's `MCP-Protocol-Version` is `2025-11-25` or later. Before, a client whose GET stream was closed by `closeStandaloneSSEStream()` before it had received an event reconnected without `Last-Event-ID` and lost the notifications sent in between. Opening the GET stream now waits for `eventStore.storeEvent()` and responds 500 if it fails. Each GET stream stores one priming event (`{}`) under the standalone stream ID; replays skip these.
