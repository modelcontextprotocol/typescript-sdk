---
status: scaffold
shape: how-to
---
# Subscribe to changes

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: listen filters vs legacy subscribe.
teaches: Client.listen, McpSubscription (honoredFilter, closed, close), Client.setNotificationHandler, ClientOptions.listChanged, Client.subscribeResource, Client.unsubscribeResource
source: mined from docs/client.md "Subscription streams (2026-07-28)", "Automatic list-change tracking", "Manual notification handlers", "Subscribing to resource changes"
-->

## Open a subscription stream

<!-- teaches: Client.listen(filter) -> McpSubscription, setNotificationHandler dispatch | salvage: docs/client.md "Subscription streams (2026-07-28)" -->

```ts
// draft - API verified against packages/client/src/client/client.ts (listen(filter: SubscriptionFilter, options?): Promise<McpSubscription>)
client.setNotificationHandler('notifications/tools/list_changed', async () => {
  const { tools } = await client.listTools();
  console.log('Tools changed:', tools.length);
});

const subscription = await client.listen({
  toolsListChanged: true,
  resourceSubscriptions: ['config://app'],
});
console.log('Server honored:', subscription.honoredFilter);
```

<!-- result: listen() resolves once the server acknowledges; honoredFilter is the subset the server actually agreed to deliver. -->

## Handle the notifications

<!-- teaches: Client.setNotificationHandler for notifications/resources/updated and the three list_changed methods | salvage: docs/client.md "Manual notification handlers" -->
<!-- code: setNotificationHandler('notifications/resources/updated', ...) re-reading the resource -->

## Close the stream and react to closure

<!-- teaches: subscription.close(), subscription.closed (resolves 'local' | 'graceful' | 'remote'), the re-listen loop | salvage: docs/client.md "Subscription streams" (watch-loop block) -->
<!-- code: await sub.closed; re-listen only when the reason is 'remote' -->

## Let the SDK open the stream for you

<!-- teaches: ClientOptions.listChanged, Client.autoOpenedSubscription | salvage: docs/client.md "Automatic list-change tracking" -->
<!-- code: new Client(info, { listChanged: { tools: true } }) — the SDK opens and filters the stream from the intersection with the server's capabilities -->

## Fall back to legacy per-resource subscribe

<!-- teaches: Client.subscribeResource / Client.unsubscribeResource (2025-era resources/subscribe) | salvage: docs/client.md "Subscribing to resource changes" -->
<!-- code: subscribeResource({ uri }), the same notifications/resources/updated handler, unsubscribeResource({ uri }) -->
<!-- aside: ::: info — one-line era cross-link to /protocol-versions: listen() is 2026-07-28; subscribeResource() is 2025-era. Each throws a typed error on the wrong era. -->

## Recap

<!-- the claims this page will prove:
- listen(filter) opens one stream carrying every change notification you asked for; honoredFilter tells you what the server granted.
- Notifications dispatch through setNotificationHandler regardless of how they arrived.
- closed resolves exactly once with the reason; there is no automatic re-listen.
- listChanged in ClientOptions opens and manages the stream for you.
- subscribeResource is the legacy per-resource path; which one your connection supports is an era question (/protocol-versions).
-->
