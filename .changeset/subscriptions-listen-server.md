---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/server': minor
---

`subscriptions/listen` (SEP-1865) is served by both serving entries on protocol revision 2026-07-28. The entry owns ack-first, per-stream filtering, subscription-id stamping, keepalive (HTTP), the pre-ack `-32603` capacity guard, and teardown (HTTP stream close; one
`notifications/cancelled` per subscription on stdio). `server/discover` now advertises `listChanged`/`subscribe` capability bits — the rider that suppressed them until listen was served is discharged.

Under `createMcpHandler` the consumer's factory **is** constructed for `subscriptions/listen` (a capabilities-only probe so the acknowledged filter reflects what the server advertises; the instance is never connected and is closed immediately). Per-request authorization performed inside the factory therefore sees listen requests; token verification still belongs at the middleware layer mounted in front of the entry.

New public surface:

- `@modelcontextprotocol/server`: `ServerEventBus`, `ServerEvent`, `ServerNotifier` (types); `InMemoryServerEventBus` (class).
- `McpHttpHandler` gains `.notify` (`ServerNotifier`: `toolsChanged()`, `promptsChanged()`, `resourcesChanged()`, `resourceUpdated(uri)`) and `.bus` (the `ServerEventBus` listen streams subscribe to).
- `CreateMcpHandlerOptions` gains `bus?: ServerEventBus` (an in-process `InMemoryServerEventBus` is created when omitted), `maxSubscriptions?: number` (default 1024), and `keepAliveMs?: number` (default 15000).
- `ServeStdioOptions` gains `maxSubscriptions?: number` (default 1024). On a modern-pinned connection `serveStdio` routes the pinned instance's existing `send*ListChanged()` calls onto active subscriptions; legacy connections are unchanged.
- `@modelcontextprotocol/core`: `SUBSCRIPTION_ID_META_KEY` (const); `SubscriptionFilter`, `SubscriptionsListenRequest`, `SubscriptionsListenRequestParams`, `SubscriptionsAcknowledgedNotification`, `SubscriptionsAcknowledgedNotificationParams` (types).
