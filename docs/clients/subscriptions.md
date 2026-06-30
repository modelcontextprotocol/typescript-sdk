---
shape: how-to
---

# Subscribe to changes

A **subscription stream** is one long-lived `subscriptions/listen` request that carries every change notification you opted in to. On a connection that negotiated [2026-07-28](../protocol-versions.md), change notifications arrive only on a stream you open — nothing arrives unsolicited.

## Open a subscription stream

`listen` takes a **filter** naming the notification types you want. Register a handler for each type with `setNotificationHandler` before you open the stream.

```ts source="../../examples/guides/clients/subscriptions.examples.ts#listen_open"
client.setNotificationHandler('notifications/tools/list_changed', async () => {
    const { tools } = await client.listTools();
    console.log('Tools changed:', tools.length);
});

const subscription = await client.listen({
    toolsListChanged: true,
    resourceSubscriptions: ['config://app']
});
console.log('Server honored:', subscription.honoredFilter);
```

`listen()` resolves once the server acknowledges the stream, and returns an `McpSubscription` whose `honoredFilter` is the subset of your filter the server agreed to deliver:

```
Server honored: { toolsListChanged: true, resourceSubscriptions: [ 'config://app' ] }
```

The server narrows the filter to its advertised capabilities — `resourceSubscriptions` survives only when it advertises `resources: { subscribe: true }`, and each list-change field only when the matching `listChanged` capability is set. The four filter fields are `toolsListChanged`, `promptsListChanged`, `resourcesListChanged`, and `resourceSubscriptions` (an array of resource URIs).

## Handle the notifications

`resourceSubscriptions` asked for per-resource updates; register the matching handler and re-read the resource when it fires.

```ts source="../../examples/guides/clients/subscriptions.examples.ts#listen_updated"
client.setNotificationHandler('notifications/resources/updated', async notification => {
    const { contents } = await client.readResource({ uri: notification.params.uri });
    console.log('Updated', notification.params.uri, contents);
});
```

Every notification on the stream dispatches through `setNotificationHandler` — the same registration an unsolicited 2025-era notification fires, so register once for either delivery path. When the server publishes a tool change and an update to `config://app`, both handlers fire from the one stream:

```
Tools changed: 2
Updated config://app [ { uri: 'config://app', text: '{"theme":"dark"}' } ]
```

## Close the stream and react to closure

`close()` tears the stream down. `closed` resolves exactly once with the reason — it never rejects.

```ts source="../../examples/guides/clients/subscriptions.examples.ts#listen_close"
await subscription.close();
console.log('Closed:', await subscription.closed);
```

The reason names who ended the stream:

```
Closed: local
```

`'local'` means you closed it, `'graceful'` means the server ended the subscription deliberately, and `'remote'` means the stream dropped without a response. The SDK never re-listens for you.

Re-listen only on `'remote'`:

```ts source="../../examples/guides/clients/subscriptions.examples.ts#listen_watchLoop"
while (watching) {
    const sub = await client.listen({ resourceSubscriptions: ['config://app'] });
    const reason = await sub.closed;
    if (reason !== 'remote') break; // 'local' or 'graceful': done
    await new Promise(resolve => setTimeout(resolve, 1000)); // back off, then re-listen
}
```

## Let the SDK open the stream for you

The `listChanged` client option opens and manages the stream itself.

```ts source="../../examples/guides/clients/subscriptions.examples.ts#listChanged_auto"
const watcher = new Client(
    { name: 'notes-watcher', version: '1.0.0' },
    {
        listChanged: {
            tools: {
                onChanged: (error, tools) => {
                    if (error) {
                        console.error('Refresh failed:', error);
                        return;
                    }
                    console.log('Tools refreshed:', tools?.length);
                }
            }
        }
    }
);
```

After `connect()` the SDK opens the stream from the intersection of the `listChanged` types you configured and the capabilities the server advertises, and exposes the handle as `autoOpenedSubscription`. On every change the SDK re-fetches the list and hands it to `onChanged`:

```
Tools refreshed: 1
```

::: warning
`listChanged` registers its own handler for each configured `list_changed` type during `connect()`. The last registration for a notification type wins, so a manual `setNotificationHandler` for that type registered after connecting silently disables `listChanged` for it.
:::

## Fall back to legacy per-resource subscribe

On a 2025-era connection, request per-resource updates with `subscribeResource` instead.

```ts source="../../examples/guides/clients/subscriptions.examples.ts#subscribeResource_legacy"
await client.subscribeResource({ uri: 'config://app' });

// The same notifications/resources/updated handler fires.

await client.unsubscribeResource({ uri: 'config://app' });
```

The notification it produces is the same `notifications/resources/updated`, dispatched to the handler you already registered.

::: info
`listen()` is 2026-07-28-only and `subscribeResource()` is 2025-era — on the wrong era each rejects with an `SdkError` whose code is `METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION`. See [Protocol versions](../protocol-versions.md).
:::

## Recap

- `listen(filter)` opens one stream carrying every change notification you asked for; `honoredFilter` is the capability-gated subset the server granted.
- Notifications on the stream dispatch through `setNotificationHandler` — the same registrations 2025-era unsolicited notifications fire.
- `closed` resolves exactly once with `'local'`, `'graceful'`, or `'remote'`, and never rejects; there is no automatic re-listen.
- The `listChanged` client option opens and manages the stream for you, exposed as `autoOpenedSubscription`.
- `subscribeResource` and `unsubscribeResource` are the 2025-era per-resource path; which path your connection supports is an era question.
