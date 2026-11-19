---
shape: how-to
---

# Events

::: warning Experimental
Events (SEP-3415) is an accepted MCP extension. Its SDK API is new and may change in a minor release.
:::

`EventsClientExtension` subscribes to a server's event types, and you read each **subscription** with `for await`.

```ts source="../../examples/guides/clients/events.examples.ts#subscribe_basic"
import { Client } from '@modelcontextprotocol/client';
import { EventsClientExtension } from '@modelcontextprotocol/client/ext/events';

const events = new EventsClientExtension();
const client = new Client({ name: 'ops-console', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' }, extensions: [events] });
await client.connect(transport);

const subscription = await events.subscribe({ name: 'ticket.updated', arguments: { queue: 'billing' } });
for await (const event of subscription) {
    console.log(event.name, event.data);
    break;
}
```

When a ticket in the billing queue opens, it prints:

```text
ticket.updated { ticketId: 'T-7', status: 'open' }
```

Pass the extension in the client's `extensions` option: the client calls its `setup` while it is constructed, which ties the extension to that one client. `subscribe()` resolves once its first exchange with the server succeeds, and the subscription starts from now unless you pass a `cursor`. `list()` returns the server's event types with their schemas and delivery modes.

Each subscription takes the first delivery mode the event type offers out of webhook (when you configure it), push and poll; `delivery` forces one, and `subscription.deliveryMode` says which it got. Without `delivery`, when a push subscription's first stream fails before its first `notifications/events/active` with anything but an `EventsError` (no valid `active` within the request timeout, say, behind a host that buffers whole responses), the client reports the failure to its `onerror` and subscribes by poll instead, if the event type offers poll. The loop is the same in every mode, drops a repeated `eventId`, and leaving it cancels the subscription.

::: info
Events is used on protocol 2026-07-28 only, so create the client with `versionNegotiation: { mode: 'auto' }` or a pin — see [Protocol versions](../protocol-versions.md).
:::

## Resume from a saved cursor

`subscription.cursor` is the newest cursor that is safe to save; pass it back as `cursor` to pick up where the loop stopped.

```ts source="../../examples/guides/clients/events.examples.ts#subscribe_cursor"
// Save the cursor; it covers every event the loop finished with.
const saved = subscription.cursor;

// Later, maybe in a new process: resume from the saved cursor.
const resumed = await events.subscribe({ name: 'ticket.updated', arguments: { queue: 'billing' }, cursor: saved });
for await (const event of resumed) {
    console.log(event.name, event.data);
    if (event.data.status === 'closed') break;
}
```

Meanwhile the ticket was closed. The resumed subscription delivers the event the first loop broke on again, then the change it missed:

```text
ticket.updated { ticketId: 'T-7', status: 'open' }
ticket.updated { ticketId: 'T-7', status: 'closed' }
```

The cursor covers the events the loop finished with, and the loop finishes with an event when it asks for the next one, so a resumed subscription can repeat the last event: handle events idempotently, or skip an `eventId` you have handled. An event type that cannot resume has a `null` cursor, and there is nothing to save.

`onGap` receives the fresh cursor when events may have been skipped: the server reported `truncated`, or delivery started again from now after a schema change made the server refuse your cursor. Closing the client, or connecting it again, ends every subscription, and the loop rejects with an `SdkError` (`ConnectionClosed`). After reconnecting, subscribe again and pass the cursor you saved.

## Receive events by webhook

Give the extension a webhook URL and serve its receiver there.

```ts source="../../examples/guides/clients/events.examples.ts#webhook_receiver"
import { Hono } from 'hono';

const hooked = new EventsClientExtension({ webhook: { url: 'https://hooks.example.com/mcp/events' } });
const handleWebhook = hooked.createWebhookHandler();

// Serve the receiver at the webhook URL from any fetch-style server; here, Hono.
const app = new Hono();
app.post('/mcp/events', c => handleWebhook(c.req.raw));
```

With `webhook` set, a subscription prefers webhook wherever the event type offers it: the server POSTs each event to the URL, and the receiver checks the signature and routes the event into its subscription's loop. The client makes a `whsec_` secret for each server subscription (or takes one from `secretProvider`), answers the server's verification challenge, and refreshes the subscription before it expires. `subscription.deliveryStatus` holds the delivery health the server last reported.

Webhook subscriptions with the same name and arguments share one server subscription, and cancelling the last of them sends `events/unsubscribe`. The SDK's server accepts a webhook subscription only from an authenticated principal and answers `forbidden` otherwise. The receiver answers `503` to a subscription it does not know yet, and the server retries.

The receiver answers `2xx` once it has queued an event in memory, so events queued but not yet read by your loop are lost if the process exits. Subscribing again within the grant, while the server still delivers to the subscription, continues from the server's position rather than from your saved cursor.

## Handle errors

Catch `EventsError` around `subscribe()` and the loop; `kind` says what went wrong.

```ts source="../../examples/guides/clients/events.examples.ts#errors"
import { EventsError } from '@modelcontextprotocol/client/ext/events';

try {
    const refused = await events.subscribe({ name: 'ticket.updated', arguments: { queue: 42 } });
    for await (const event of refused) console.log(event.data);
} catch (error) {
    if (!(error instanceof EventsError)) throw error;
    console.log(error.kind);
}
```

The server rejects `queue: 42` against the event type's `inputSchema`, so it prints:

```text
invalidParams
```

`subscribe()` rejects with an `EventsError` when the server does not list the event type or refuses the subscription (`notFound`, `invalidParams`, `forbidden`, `unsupported`, `resourceExhausted` or `callbackEndpointError`), and with an `SdkError` when the exchange fails in the SDK, such as a closed connection or a push stream with no valid `notifications/events/active` within the request timeout; other failures of the first exchange are retried in the background. A push subscription that can fall back to poll, as above, does so instead on any of these failures but an `EventsError` or a closed connection. The server's webhook verification limit (`resourceExhausted` with `data.limit: 'verification'`) is one of those: the client subscribes again after `data.retryAfterMs` (or its usual backoff without one), before and after the first exchange. Once subscribed, the loop ends with an `EventsError` when the server ends the subscription, such as `forbidden` when access is revoked. A `notFound`, or an `unsupported` for a schema change, makes the client list the event types again and carry on while the type is still offered in that mode.

`NoCompatibleDeliveryModeError` means no delivery mode the event type offers is usable here: webhook needs the `webhook` option, and `delivery` narrows the choice to one mode. Against a server without Events, or on a connection older than 2026-07-28, `events.supported` is `false`, and `list()` and `subscribe()` throw `SdkError` (`CapabilityNotSupported`). An error thrown from `onGap` goes to the client's `onerror`.

## Recap

- `new EventsClientExtension()` in the client's `extensions`, then `connect()`, `subscribe({ name, arguments })` and `for await`.
- The loop is the same in every mode, and leaving it cancels the subscription.
- `subscription.cursor` is safe to save; pass it back as `cursor` to resume, and expect the last event again.
- `webhook: { url }`, with `createWebhookHandler()` served at that URL, turns on webhook delivery.
- `subscribe()` and the loop fail with an `EventsError` whose `kind` says why.
