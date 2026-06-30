---
status: scaffold
shape: how-to
---
# Notifications

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Notify clients of changes.
teaches: sendToolListChanged, sendPromptListChanged, sendResourceListChanged, sendResourceUpdated, handler.notify, ServerEventBus
source: mined from docs/server.md "Change notifications"
era note (R8): the main column tells the handler.notify story once; the 2025-era hand-wired
subscribe path is a labeled aside, not a peer H2. The page's one era line links /protocol-versions.
-->

## Send a list-changed notification
<!-- teaches: McpServer.sendToolListChanged() (and the prompt/resource siblings) | salvage: docs/server.md "Change notifications" -->

```ts
// draft - API verified against packages/server/src/server/mcp.ts (sendToolListChanged, line 1129)
server.sendToolListChanged();
```
<!-- result: connected clients that declared the capability receive notifications/tools/list_changed and re-list. -->

## Let registration changes notify for you
<!-- teaches: registering, enabling, disabling, updating, or removing a tool/prompt/resource emits the matching list_changed automatically | salvage: docs/server.md "Change notifications" (List changes) -->
<!-- code: registeredTool.update(...) / .disable() with a comment on the notification each emits -->

## Advertise the `listChanged` capability
<!-- teaches: McpServer advertises listChanged on registration; declare it up front only on the low-level Server | salvage: docs/server.md "Change notifications" -->
<!-- code: capabilities: { tools: { listChanged: true } } on a low-level Server -->

## Publish a resource update through the handler
<!-- teaches: clients subscribe via the serving entries (subscriptions/listen); you publish through the handler.notify.resourceUpdated / toolsChanged facade | salvage: docs/server.md "Change notifications" (subscriptions_notify) -->
<!-- code: const handler = createMcpHandler(() => buildServer()); handler.notify.resourceUpdated('config://app') -->
<!-- result: every client subscribed to that URI receives notifications/resources/updated -->
<!-- aside (::: info Coming from 2025-era subscriptions, labeled): resources: { subscribe: true } plus
     hand-wired resources/subscribe/unsubscribe handlers and sendResourceUpdated({ uri }) still work
     on older connections — compressed to this aside; salvage docs/server.md (subscriptions_legacy).
     The era detail is ONE line linking /protocol-versions. -->

## Pick an event bus for multi-process deployments
<!-- teaches: InMemoryServerEventBus default; supply a ServerEventBus via the `bus` option when you run more than one process | salvage: docs/server.md "Change notifications" closing paragraph -->
<!-- code: createMcpHandler(factory, { bus: myBus }) placeholder; cross-link serving/sessions-state-scaling.md -->

## Recap
<!-- the claims this page will prove:
- send*ListChanged() pushes a list_changed notification; registration changes already send it for you.
- Delivery is capability-gated: only clients (and servers) that declared listChanged participate.
- Clients subscribe to per-resource updates through the serving entry; you publish through the handler's notify facade.
- One process needs nothing; multiple processes share a ServerEventBus.
-->
