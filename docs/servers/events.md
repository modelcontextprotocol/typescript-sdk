---
shape: how-to
---

# Events

::: warning Experimental
Events is an MCP extension at the Beta stage, defined by SEP-3415; see [its specification](https://github.com/modelcontextprotocol/ext-events/blob/main/specification/beta/events/events.mdx). Its SDK API is new and may change in a minor release.
:::

`registerEvent` with a `check` function publishes an **event type**: the SDK reads new events from your upstream for every client that subscribes.

```ts source="../../examples/guides/servers/events.examples.ts#registerEvent_check"
import { EventsExtension } from '@modelcontextprotocol/server/ext/events';
import * as z from 'zod/v4';

// Your upstream: here, a log of ticket changes, each with the time it happened, where a cursor is a position in the log.
const changes: Array<{ changeId: string; at: string; queue: string; ticketId: string; status: string }> = [];

const events = new EventsExtension();

events.registerEvent('ticket.updated', {
    description: 'A ticket in a queue changed status',
    inputSchema: z.object({ queue: z.string() }),
    payloadSchema: z.object({ ticketId: z.string(), status: z.string() }),
    check: (ctx, { queue }, cursor) => {
        if (cursor === null) return { events: [], cursor: String(changes.length) };
        const from = Number(cursor);
        const to = Math.min(changes.length, from + (ctx.maxEvents ?? changes.length));
        const page = changes.slice(from, to).filter(change => change.queue === queue);
        return {
            events: page.map(({ changeId, at, ticketId, status }) => ({ eventId: changeId, timestamp: at, data: { ticketId, status } })),
            cursor: String(to),
            hasMore: to < changes.length
        };
    }
});
```

Clients subscribe by poll (`events/poll`) or push (`events/stream`), or by webhook (`events/subscribe`) once you turn it on, and the SDK runs each mode from this one definition. `check` returns the events since `cursor` and the cursor to resume from; for a subscription that starts now the SDK passes `cursor: null` and sends only the cursor you return. Return at most `ctx.maxEvents` events, set `hasMore` when more are waiting, and set `truncated: true` when the upstream no longer has the history since `cursor`. Give every event an `eventId` that stays the same whenever `check` returns that event again, so clients can drop a replayed one; the SDK drops an event without one and reports it to `onerror`.

Clients resume from their cursor after a disconnect or a restart, for as long as your upstream accepts it. A `check` that returns `cursor: null` marks a type that cannot resume. The SDK then calls `check` with `cursor: null` every time: it drops the events of a subscription's first call, as for any subscription that starts now, and sends the events of every later call, so return what happened since the previous call for the same `ctx.subscriptionId`. The SDK never reports `truncated` for such a type, and ignores `maxAgeMs` for it.

Poll serves such a type one subscription per lease, keyed by principal, event name and arguments: clients that share a lease (every caller on a server without `getPrincipal`, or one user's several clients) split its events between them, and a client's first poll on an existing lease can return events from before it subscribed. The SDK caps every `nextPollMs` it sends at half of `pollSubscriptionTtlMs`, how long a lease lives without a poll (5 minutes by default), but a client that polls less often than that starts a new lease each time and gets nothing. Clients that need every event use push or webhook.

::: info
Events is served on protocol 2026-07-28 only; a 2025-11-25 connection sees no Events capability and gets `-32601` for well-formed `events/*` requests — see [Protocol versions](../protocol-versions.md).
:::

## Emit events as they happen

Pass `emitOnly: true` when your upstream pushes to you, and call `emit()` on the handle `registerEvent` returns.

```ts source="../../examples/guides/servers/events.examples.ts#registerEvent_emitOnly"
// The open subscriptions, by the id the SDK gives each one.
const open = new Set<string>();

const incidents = events.registerEvent('incident.created', {
    emitOnly: true,
    description: 'A new incident was opened',
    inputSchema: z.object({ severity: z.enum(['P1', 'P2', 'P3']).optional() }),
    payloadSchema: z.object({ incidentId: z.string(), title: z.string(), severity: z.enum(['P1', 'P2', 'P3']) }),
    match: (ctx, event, { severity }) => severity === undefined || event.data.severity === severity,
    onSubscribe: ctx => {
        open.add(ctx.subscriptionId);
    },
    onUnsubscribe: ctx => {
        open.delete(ctx.subscriptionId);
    }
});

// Wherever your upstream reports an incident, for example in its webhook handler:
await incidents.emit({ eventId: 'INC-7', data: { incidentId: 'INC-7', title: 'Checkout is down', severity: 'P1' } });
```

`emit()` sends the event to every subscription that `match` accepts, and `transform` reshapes it per subscription. Route an event meant for one subscriber with `match`, on the subscription's arguments or `ctx.principal`. An event emitted without an `eventId` gets one the SDK generates, which every replay of it keeps. The SDK drops an event whose `data` fails `payloadSchema`, or whose `transform` output does, and one that cannot be serialised to JSON (a `BigInt` in its `data` or `_meta`, say), and reports it to `onerror`, for both kinds.

Poll clients read emit-only events from an in-memory buffer (`emitBuffer`, by default the last 10 minutes and at most 10 000 events), so events emitted before a restart are lost, and a poll from a cursor the buffer has since evicted gets `truncated: true` with the oldest events it still holds. Push and webhook subscriptions that pass a cursor replay that buffer first. `onSubscribe` and `onUnsubscribe` run as a subscription starts and ends, in every mode, and `ctx.subscriptionId` names it.

## Serve the event types from every server

Pass the extension in each server's `extensions` option; one `EventsExtension` serves every server constructed with it.

```ts source="../../examples/guides/servers/events.examples.ts#extensions"
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

const handler = createMcpHandler(() => new McpServer({ name: 'helpdesk', version: '1.0.0' }, { extensions: [events] }));
```

While it is constructed, each server advertises the extension and calls its `setup`, which registers the `events/*` methods (see [Extensions](../advanced/extensions.md)). Push streams under every `responseMode`, `'json'` included, as `subscriptions/listen` does. On a host that buffers whole responses push cannot work: the SDK's client falls back to poll once its first push stream times out, or set `delivery: { push: false }` on the event type so clients choose poll at once.

A push stream carries no SSE comment keepalive. The server sends `notifications/events/heartbeat` whenever the stream has been quiet for the granted interval, `heartbeatMs` (30 seconds by default) or a shorter one the client asks for, and the SDK's client reconnects after three intervals of silence. Keep `heartbeatMs` below your load balancer's idle timeout.

Both hold under `createMcpHandler`. A custom HTTP entry built directly on `PerRequestHTTPServerTransport` must stream `events/stream` itself: serve it with `responseMode` `'auto'` or `'sse'`, never `'json'`, and the transport's `keepAliveMs` applies to it as to any stream.

Over HTTP, the SDK hands a push stream's next message to the response only while its client has at most 1 MiB unread, so a replay or a burst goes out at the pace the client reads. A stream whose client leaves more than that unread for its whole heartbeat interval is abandoned: the SDK drops the unread bytes and ends the subscription, and the SDK's client reconnects from its cursor. So is an emit-only stream that gets a live event while its client is over that bound and `emitBuffer.maxEvents` live events already wait for it (the replay it starts with does not count, and a burst emitted while the client keeps up waits in full), and a stream that ends while its client is more than 1 MiB behind, or falls that far behind as its last messages go out. An abandoned stream's response body errors, and a runtime that serves the web `Response` aborts the HTTP response; under `toNodeHandler` the response ends once the client reads what its socket already holds, or closes when the client disconnects. On a transport that cannot tell how far its client has read, such as stdio, an emit-only stream that gets a live event while `emitBuffer.maxEvents` live events already wait for it, and while the transport has been writing its current message for longer than the stream's heartbeat interval, is abandoned, whatever their size, so a burst does not count while the transport keeps writing: the subscription ends, the events still queued for it are not sent, and its final result follows what the transport already holds, so the SDK's client reconnects from its cursor once it reads again.

On every transport, a `check` type's stream runs its next `check` only once its last batch has been written to the transport: at once when that batch was a page with more waiting (`hasMore`) that moved on (had events or a new cursor), otherwise after `checkIntervalMs`. Push passes `ctx.maxEvents` (100), as poll passes the `maxEvents` its request asks for (100 by default), which the server caps at 1 000 for every poll, so a long backlog goes out a page at a time.

One `EventsExtension` serves at most `maxSubscriptions` subscriptions at once, 1024 by default, counting its poll leases, push streams and the webhook subscriptions this process created; it refuses more with `resourceExhausted` (`data.limit: 'subscriptions'`). With `getPrincipal` set, each principal may hold a quarter of them (for a new webhook subscription, counting also the webhook subscriptions this process serves for it), and so may all callers without a principal together, refused past that with `data.limit: 'principalSubscriptions'`; without `getPrincipal` only the process-wide limit applies. In every mode it refuses `arguments` longer than 65 536 characters as canonical JSON, and a request longer than 131 072 as the SDK keeps it (its id, params and `_meta` as received, counting only the `inputResponses` entries it accepts), with `invalidParams`.

## Deliver events to webhooks

Set `webhookTtlMs`, `webhookSender` and `getPrincipal` together to offer webhook delivery. On Cloudflare Workers, timers stop when the request that set them ends, so use poll or push there; webhook retries, `check` loops and expiry need a long-lived process.

```ts source="../../examples/guides/servers/events.examples.ts#webhook_setup"
import type { ServerContext } from '@modelcontextprotocol/server';
import { nodeWebhookSender } from '@modelcontextprotocol/server/ext/events/node';

// The user your token verifier authenticated; this one puts the subject in AuthInfo.extra.
function principalOf(ctx: ServerContext): string | null {
    const sub = ctx.http?.authInfo?.extra?.sub;
    return typeof sub === 'string' ? sub : null;
}

const webhookEvents = new EventsExtension({
    webhookTtlMs: 30 * 60_000,
    webhookSender: nodeWebhookSender(),
    getPrincipal: principalOf
});
```

Setting `webhookTtlMs` or `webhookSender` without the other two throws `TypeError`. `getPrincipal` has no default, since `AuthInfo` has no subject field: return the user from wherever your token verifier puts it. A webhook subscription for which `getPrincipal` returns `null` is refused with `forbidden`, on stdio too, and `events/list` leaves `webhook` out of what it offers such a caller (and leaves out a type that then offers no mode), so the list can differ per caller; poll and push use the principal when there is one. A `delivery.url` must be at most 2 048 characters long, and an absolute `https` URL unless its origin is in `trustedOrigins`; the SDK refuses any other with `invalidParams`.

`webhookTtlMs` is the longest a webhook subscription lives without a refresh, and clients refresh before it lapses. The SDK verifies each endpoint with a challenge before the first delivery, signs every POST (Standard Webhooks), and retries a failed delivery up to five attempts in all. It sends at most ten event POSTs per subscription at a time, so a replayed backlog goes out ten at a time. Besides those waiting between retries, it holds at most 10 000 more of a subscription's events waiting for their turn or for a suspended delivery to resume, so a replay, or a `check` result that ignores `ctx.maxEvents`, larger than that loses its oldest waiting events. It abandons an event past that cap or after its fifth failed attempt, and reports these to `onerror` at most once a minute per subscription, with how many. A `check` type pages through a backlog in every mode: its webhook loop also passes `ctx.maxEvents` (100), and after a page with more waiting that moved on it reads the next page as soon as every event of the last one has been acknowledged or abandoned. The subscriber learns of an abandoned event, or of one the receiver answered `413` or whose body is over 256 KiB, as a gap: a `gap` POST after the next delivery its receiver acknowledges, and `truncated: true` on every refresh this process answers meanwhile. Each attempt of that POST goes out once none of the subscription's event POSTs is in flight, carrying the watermark then. The gap stays marked until the receiver acknowledges that POST, which is sent again after the next acknowledged delivery if it fails, or until a refresh carries the cursor the last `truncated: true` answer returned, when the refresh that got that answer carried another cursor. It sends each destination host one challenge at a time, so a subscribe waits while another challenge to that host is in flight, and at most ten in any 60 seconds; past that, when ten subscribes already wait for the host, when three of a principal's challenges, to any hosts, are already waiting or being sent, or once three of a principal's challenges to the host, or ten to any hosts, failed within 60 seconds (those last two for that principal only, while others keep their places and the host's remaining room), it refuses with `resourceExhausted` (`data.limit: 'verification'`; `data.retryAfterMs` says when to try again, and the SDK's client does). It answers a principal's subscribes to a URL whose challenge failed with that failure for 60 seconds, without another challenge. `nodeWebhookSender()` requires `https`, resolves the host at every send by querying DNS directly (so `/etc/hosts` does not apply; origins in `trustedOrigins` skip resolution), refuses IANA special-purpose addresses (loopback, private, link-local and the like) and connects only to the addresses it checked, IPv4 and IPv6 (only those of a family the host has an address of that is neither loopback nor link-local, unless that leaves none or the host's interfaces cannot be read); it follows no redirects and gives up after 5 seconds.

::: warning
`trustedOrigins` is for development only. Its exact origins, such as `http://127.0.0.1:9000`, are exempt from the `https` rule and the private-address check, so a receiver on your machine can take deliveries; endpoint verification, signing and the no-redirect rule still apply.
:::

## Share webhook subscriptions across replicas

Webhook subscriptions live in a `WebhookSubscriptionStore`, in process memory by default; give every replica one shared store.

```ts source="../../examples/guides/servers/events.examples.ts#webhook_store"
import type { WebhookSubscriptionRecord, WebhookSubscriptionStore } from '@modelcontextprotocol/server/ext/events';

// What the store needs from a database every replica shares, such as Redis.
interface SharedKeyValue {
    get(key: string): Promise<string | undefined>;
    // The database deletes the key at expiresAt (with Redis: SET ... PXAT expiresAt).
    set(key: string, value: string, expiresAt: number): Promise<void>;
    delete(key: string): Promise<boolean>;
    keys(prefix: string): AsyncIterable<string>;
}

function sharedWebhookStore(kv: SharedKeyValue): WebhookSubscriptionStore {
    const read = async (id: string) => {
        const json = await kv.get(`events:sub:${id}`);
        return json === undefined ? undefined : (JSON.parse(json) as WebhookSubscriptionRecord);
    };
    return {
        get: read,
        async put(record) {
            // A minute past expiresAt, so the SDK's expiry timer still reads the record and runs onUnsubscribe.
            const keepUntil = record.expiresAt + 60_000;
            await kv.set(`events:sub:${record.id}`, JSON.stringify(record), keepUntil);
            await kv.set(`events:name:${record.name}:${record.id}`, '', keepUntil);
        },
        async delete(id) {
            const record = await read(id);
            if (record !== undefined) await kv.delete(`events:name:${record.name}:${id}`);
            return kv.delete(`events:sub:${id}`);
        },
        async *listByName(name) {
            const prefix = `events:name:${name}:`;
            for await (const key of kv.keys(prefix)) {
                const record = await read(key.slice(prefix.length));
                if (record !== undefined) yield record;
            }
        }
    };
}

// `kv` is your SharedKeyValue client for that database, connected at startup.
const replicated = new EventsExtension({
    webhookTtlMs: 30 * 60_000,
    webhookSender: nodeWebhookSender(),
    webhookStore: sharedWebhookStore(kv),
    getPrincipal: principalOf
});
```

Records hold each subscription's webhook secret, so protect the store as you protect credentials. The SDK deletes an expired record when it next reads it, or when the expiry timer of the replica that last granted it fires, and runs `onUnsubscribe` then. The store above keeps each record a minute past its `expiresAt`, because a record the database has already dropped is gone when that timer reads it, and `onUnsubscribe` never runs for it. A record that a stopped replica left behind stays until something reads it, so let the store expire records too, as the expiry passed to `set()` above does (with Redis, a key TTL).

A store that outlives the process carries webhook subscriptions across a restart. Emit-only types keep delivering to the stored subscriptions, without a resubscribe or a new verification; a `check` type's loop starts again at the subscription's next refresh, from the cursor the client supplies. The new process delivers to them, refreshes them and may end them (running `onUnsubscribe`) without running `onSubscribe`, so keep what their delivery needs, such as an upstream watcher that calls `emit()`, outside the process. The events of an emit-only type the old process had not delivered are lost with its buffer, so the new process reports a gap for each such subscription created before it started (`onGap` may run more than once for it), whichever comes first: a `gap` POST after its first delivery the receiver acknowledges, or `truncated: true` with a fresh cursor on the first refresh it answers when its buffer cannot serve the client's cursor (and on the next refresh if that carries the same cursor, as a retry after a lost answer does). On Cloudflare Workers, whose clock reads 0 where the extension is built, a process counts as started when it first handles a webhook subscription, so each new isolate counts as one that started.

A replica runs `onUnsubscribe` after its `delete()` resolved `true`. Replicas racing on a store whose `delete()` is not atomic may each run it for one subscription, so keep `onUnsubscribe` idempotent.

`emit()` does not wait for the store: the emits of a type that arrive while its last listing still runs share the next one, which holds at most 10 000 of them, and past that the SDK drops the oldest, reports the drops to `onerror` at most once a minute per type, with how many, and gives every subscription that listing reaches a gap. When a store read fails while `emit()` hands events to their webhook subscriptions, the SDK lists them again, up to three tries within a few hundred milliseconds, and skips those it already reached. A store that keeps failing drops those events for the webhook subscriptions it could not list; the SDK reports the failure to `onerror`, and the type's next listing gives every subscription it reaches a gap.

With a shared store, webhook subscribe, refresh, secret rotation and unsubscribe work on any replica, and `emit()` on any replica reaches every matching webhook subscription. Some state stays on one process:

- `emit()` reaches push streams and the poll buffer on the emitting process only. A poll, or a webhook subscribe that resumes from a cursor, that lands on another replica gets `truncated: true` and a fresh cursor, and so does the first refresh of an emit-only type's webhook subscription that a replica other than the one that created it answers, when its buffer cannot serve that refresh's cursor. A replica that started after the subscription was created (a restart or a new replica) reports that gap by a `gap` POST after its first delivery the receiver acknowledges instead, when that comes first. Either way each replica reports the gap for a subscription once, plus a repeat when an answer is lost (the next refresh it answers carries the same cursor) or a `gap` POST crosses a refresh.
- A webhook subscription to a `check` type runs its `check` loop on every replica that handled its subscribe or a refresh, so its receiver may get an event more than once (same `eventId`, different `webhook-id`); the SDK's client drops the repeats by `eventId`. Prefer emit-only types for webhook subscribers, or run one replica.
- `onSubscribe` runs only on the replica that creates a webhook subscription, while any replica delivers to it, refreshes it and may end it (running `onUnsubscribe`), so keep what its delivery needs, such as an upstream watcher that calls `emit()`, outside any one replica.
- A replica counts toward `maxSubscriptions` only the webhook subscriptions it created, while a principal's share for new webhook subscriptions also counts the ones the replica serves for it, those refreshed here since it started, so after a restart the share holds once the principal's subscriptions have been refreshed; until then the principal may create more. A replica keeps serving a subscription once it has refreshed it, so across a fleet a principal's webhook share tends toward one share in all, and a subscription ended on another replica counts here until its grant ends. The SDK keeps no store-wide total, so after a restart the process-wide limit covers only what the new process created.
- `remove()` on one replica may skip `onUnsubscribe` for subscriptions another replica handled.
- Retries, the delivery watermark and `deliveryStatus` stay with the replica that delivers.
- Events a replica abandoned are a gap it reports itself: it keeps answering `truncated: true` to the refreshes that reach it until its `gap` POST is acknowledged or a refresh carries the cursor its last `truncated: true` answer returned (when the refresh that got that answer carried another cursor), so `onGap` may run more than once for one gap.

## End a subscription

`terminate` ends subscriptions with an `EventsError`, for example when the subscriber lost access.

```ts source="../../examples/guides/servers/events.examples.ts#terminate"
import { EventsError } from '@modelcontextprotocol/server/ext/events';

// Ends one subscription, by the id its hooks received as ctx.subscriptionId.
function revoke(subscriptionId: string): Promise<void> {
    return incidents.terminate(new EventsError('forbidden', 'Access revoked'), { subscriptionId });
}
```

Without `subscriptionId`, `terminate` ends every subscription of the type. The client gets the error in its mode's form (a poll error response, a push `terminated` notification after the events emitted before it, a webhook `terminated` POST; a push stream whose client is, or falls, more than 1 MiB behind as it ends is abandoned instead, as above; and a push client may reconnect at any time, including when it closes its own stream while its loop is behind, so refuse it in `onSubscribe` too when the end must stick), and the SDK's client ends its loop with it, unless it is `notFound` and the type is still offered in that mode. `terminate` reaches webhook subscriptions on every replica through the store, and push and poll subscriptions on this process only.

Throw an `EventsError` from `onSubscribe` to refuse a subscription, or `EventsError('forbidden', …)` from `check` to end one. Change an event type with the handle's `update()` for additive changes only; registering the name again with a different schema ends its subscriptions with `unsupported` (`reason: 'schema_changed'`), and `remove()` ends them with `notFound`.

::: warning
An `EventsError` thrown from `onUnsubscribe`, `match` or `transform` only reaches `onerror`, since nothing waits for an answer there; a throwing `match` or `transform` also skips the event for that subscription. By default `onerror` writes to stderr with `console.warn`.
:::

## Recap

- `registerEvent(name, { check })` reads events from an upstream that can answer what happened since a cursor, and clients resume from their cursor.
- `emitOnly: true` and the handle's `emit()` publish events as they happen; poll reads them from a bounded in-memory buffer.
- One `EventsExtension` serves every server constructed with it in `extensions` by poll and push, and by webhook once configured, on 2026-07-28 only; push streams under every `responseMode`.
- Webhook delivery needs `webhookTtlMs`, `webhookSender` and `getPrincipal`; `trustedOrigins` is for development only.
- A shared `WebhookSubscriptionStore` holds webhook secrets and lets replicas share webhook subscriptions, while push streams and the poll buffer stay on one process.
- `terminate` ends subscriptions with an `EventsError`, such as `forbidden` when access is revoked.
