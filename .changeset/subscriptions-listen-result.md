---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/client': minor
---

`subscriptions/listen` graceful close: per spec PR #2953, a server-side graceful close (`createMcpHandler` / `serveStdio` `close()`) now emits the empty `subscriptions/listen` JSON-RPC result (the new `SubscriptionsListenResult` — `_meta` carries the subscriptionId) before closing the stream, replacing the previous server-originated `notifications/cancelled`. On the client, `McpSubscription.closed` now resolves `'graceful'` for this signal (added alongside `'local'` and `'remote'`); a stream close without a result remains `'remote'` (unexpected disconnect).
