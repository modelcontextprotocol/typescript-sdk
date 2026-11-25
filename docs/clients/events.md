---
shape: how-to
---

# Events

::: warning Experimental
Events is an MCP extension at the Beta stage, defined by SEP-3415; see [its specification](https://github.com/modelcontextprotocol/ext-events/blob/main/specification/beta/events/events.mdx). Its SDK API is new and may change in a minor release.
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

Each subscription takes the first delivery mode the event type offers out of webhook (when you configure it), push and poll; `delivery` forces one, and `subscription.deliveryMode` says which it got. Without `delivery`, when a push subscription's first stream fails before its first `notifications/events/active` with anything but an `EventsError` (no valid `active` within the request timeout, say, behind a host that buffers whole responses, or a stream that ends before one), the client reports the failure to its `onerror` and subscribes by poll instead, if the event type offers poll. The loop is the same in every mode, drops a repeated `eventId`, and leaving it cancels the subscription.

When 1 000 events wait for your loop, delivery pauses. Until the loop has taken half of them, poll sends no `events/poll`, and push closes its stream at the next event that moves the cursor, to reopen it from there. The webhook receiver answers `503` to each event while 1 000 wait, and the server retries it; a loop that stays behind longer than the server retries gets those events as a gap, through `onGap`, and identical webhook subscriptions, which share one server subscription, pause together. On push, an event type that cannot resume keeps its stream open, and a loop that falls behind on it loses its oldest queued events, reported through `onGap` (with `null`).

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

Pass `maxAgeMs` with a `cursor` that may be old: no event older than `maxAgeMs` before `subscribe()` is delivered, for the life of the subscription, and the server reports the events it skips as a gap. The server judges a `check` event's age by its `timestamp`, and an emitted event's by when `emit()` ran, so for a `check` type this holds only as far as its events carry the time they happened.

`onGap` receives the cursor delivery continues from when events may have been skipped: the server reported `truncated`, delivery started again from now after a schema change made the server refuse your cursor, or a push loop fell 1 000 events behind on a type that cannot resume (`null`). Closing the client, or connecting it again, ends every subscription, and the loop rejects with an `SdkError` (`ConnectionClosed`). After reconnecting, subscribe again and pass the cursor you saved.

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

Webhook subscriptions with the same name and arguments share one server subscription, pause together while any of their loops is 1 000 events behind, and cancelling the last of them sends `events/unsubscribe`. The SDK's server accepts a webhook subscription only from an authenticated principal: it does not list webhook to a caller without one, so that client subscribes by push or poll. The receiver answers `503` to a subscription it does not know yet, and the server retries.

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

`subscribe()` rejects with an `EventsError` when the server does not list the event type or refuses the subscription (`notFound`, `invalidParams`, `forbidden`, `unsupported`, `resourceExhausted` or `callbackEndpointError`), with an `SdkError` when the exchange fails in the SDK, such as a closed connection, an HTTP error status other than `5xx` and `429`, or a push stream that ends before a valid `notifications/events/active` or sends none within the request timeout, and with any auth failure of the transport (such as `UnauthorizedError` for a `401` the `authProvider` cannot resolve, or an error the `authProvider` throws while it fetches a token), so a misconfigured provider fails here, or a `ProtocolError` `-32601` from a server that does not serve the method; other failures of the first exchange, such as a transport error, an HTTP `5xx` or `429`, or another JSON-RPC error, are retried in the background. The server's webhook verification limit (`resourceExhausted` with `data.limit: 'verification'`) is one of those: the client subscribes again after `data.retryAfterMs` (or its usual backoff without one), before and after the first exchange. A push subscription that can fall back to poll, as above, does so instead on any of these failures but an `EventsError`, an auth failure, a `-32601` or a closed connection. Each retried failure, such as a transport error, an HTTP error status, another JSON-RPC error or the verification limit, before the first exchange succeeds or after, goes to the client's `onerror`: the first at once, then at most one report a minute with how many were retried since. A push stream that ends after its `active` or goes silent is reopened without a report, and so is a request retried after the event types are listed again. When the server refuses the delivery mode the client selected (`unsupported` for `deliveryMode`, say after a deploy that dropped it), the client lists the event types again once and subscribes in the mode that listing selects; a mode you force with `delivery` is not changed. Once subscribed, the loop ends with an `EventsError` when the server ends the subscription, such as `forbidden` when access is revoked, with a `-32601`, and with an auth failure only the user or the configuration can fix: `UnauthorizedError`, an `SdkError` such as a `401` after re-authentication, an `OAuthError` other than `server_error`, `temporarily_unavailable` and `too_many_requests`, or an OAuth flow error such as `InsecureTokenEndpointError`. Any other error the `authProvider` throws, such as a network error or one of those `OAuthError` codes while it fetches a token, is retried and reported like a transport error. A `notFound`, or an `unsupported` for a schema change, makes the client list the event types again and carry on while the type is still offered in that mode.

`NoCompatibleDeliveryModeError` means no delivery mode the event type offers is usable here: webhook needs the `webhook` option, and `delivery` narrows the choice to one mode. Against a server without Events, or on a connection older than 2026-07-28, `events.supported` is `false`, and `list()` and `subscribe()` throw `SdkError` (`CapabilityNotSupported`). An error thrown from `onGap` goes to the client's `onerror`.

## Recap

- `new EventsClientExtension()` in the client's `extensions`, then `connect()`, `subscribe({ name, arguments })` and `for await`.
- The loop is the same in every mode, and leaving it cancels the subscription.
- `subscription.cursor` is safe to save; pass it back as `cursor` to resume, and expect the last event again.
- `webhook: { url }`, with `createWebhookHandler()` served at that URL, turns on webhook delivery.
- `subscribe()` and the loop fail with an `EventsError` whose `kind` says why.
