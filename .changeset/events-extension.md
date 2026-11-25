---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/core-internal': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/node': patch
---

author: @KKonstantinov

Add the Events extension (SEP-3415), reachable through new `ext/events` subpaths; package root exports are unchanged. The whole Events API is experimental and may change in a minor release.

- `@modelcontextprotocol/server/ext/events`: `EventsExtension`, whose `registerEvent(name, definition)` takes a `check` function or `emitOnly: true` and returns a handle with `update()`, `remove()` and `terminate()` (and `emit()` for emit-only types), and which serves `events/list`, `events/poll`, `events/stream`, `events/subscribe` and `events/unsubscribe` on every `McpServer` constructed with it in the `extensions` option; `InMemoryWebhookSubscriptionStore`; `EventsError`; the types `EventContext`, `CheckContext`, `EventInput`, `EventResult`, `EventDefinition`, `CheckEventDefinition`, `EmitOnlyEventDefinition`, `EventHandle`, `EmitOnlyEventHandle`, `EventsOptions`, `EventsErrorKind`, `WebhookSender`, `WebhookSendRequest`, `WebhookSendOutcome`, `WebhookSubscriptionStore` and `WebhookSubscriptionRecord`; and the wire types and constants. Push streams under every `createMcpHandler` `responseMode`, `'json'` included. Webhook delivery is on when `webhookTtlMs`, `webhookSender` and `getPrincipal` are all set; `trustedOrigins` exempts exact origins from the `https` and private-address rules, for development.
- `@modelcontextprotocol/server/ext/events/node`: `nodeWebhookSender()`, a `WebhookSender` for Node.js that requires `https`, resolves the host at every send, refuses IANA special-purpose addresses, follows no redirects and gives up after 5 seconds.
- `@modelcontextprotocol/client/ext/events`: `EventsClientExtension`, passed in one `Client`'s `extensions` option, with `list()`, `subscribe({ name, arguments, delivery?, cursor?, maxAgeMs?, onGap? })` and `createWebhookHandler()`; `NoCompatibleDeliveryModeError`; `EventsError`; the types `EventsClientOptions`, `SubscribeOptions`, `EventSubscription` (an async iterable with `cursor`, `deliveryMode`, `deliveryStatus` and `cancel()`) and `EventsErrorKind`; and the wire types and constants. A subscription prefers webhook (when configured), then push, then poll.
- `@modelcontextprotocol/core/ext/events`: the wire constants, a Zod schema and inferred type for every Events wire shape, and `EventsCapabilitySchema`, `EventsCapability` and `eventsCapabilityOf`.

Clients now send `Mcp-Name` on `events/poll`, `events/stream`, `events/subscribe` and `events/unsubscribe`, and `createMcpHandler` requires it on 2026-07-28 (`400` / `-32020` when it is missing or does not match `params.name`), whether or not the server serves Events.

`toNodeHandler` (`@modelcontextprotocol/node`) now destroys the response and its socket when the response body errors, where it used to end the response as if it were complete, or, while it waited for the socket to drain, stay parked until the client read or went away. A push stream whose client stops reading is ended this way.

Events is served and used on protocol 2026-07-28 only. Not included: `notifications/events/list_changed`, and webhook grants without expiry (`refreshBefore: null`). With several replicas sharing a `WebhookSubscriptionStore`, `emit()` reaches push streams and the poll buffer only on the emitting process, and the `check` loop of a webhook subscription may run on more than one replica.
