---
shape: how-to
---

# Events

::: warning Experimental
Events (SEP-3415) is an accepted MCP extension. Its SDK API is new and may change in a minor release.
:::

`registerEvent` with a `check` function publishes an **event type**: the SDK reads new events from your upstream for every client that subscribes.

```ts source="../../examples/guides/servers/events.examples.ts#registerEvent_check"
import { EventsExtension } from '@modelcontextprotocol/server/ext/events';
import * as z from 'zod/v4';

// Your upstream: here, a log of ticket changes, where a cursor is a position in the log.
const changes: Array<{ changeId: string; queue: string; ticketId: string; status: string }> = [];

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
            events: page.map(({ changeId, ticketId, status }) => ({ eventId: changeId, data: { ticketId, status } })),
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
Events is served on protocol 2026-07-28 only; a 2025-11-25 connection sees no Events capability and gets `-32601` for `events/*` — see [Protocol versions](../protocol-versions.md).
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

`emit()` sends the event to every subscription that `match` accepts, or to one with `emit(event, { subscriptionId })`; `transform` reshapes it per subscription. An event emitted without an `eventId` gets one the SDK generates, which every replay of it keeps. The SDK drops an event whose `data` fails `payloadSchema`, or whose `transform` output does, and reports it to `onerror`, for both kinds.

Poll clients read emit-only events from an in-memory buffer (`emitBuffer`, by default the last 10 minutes and at most 10 000 events), so events emitted before a restart are lost. Push and webhook subscriptions that pass a cursor replay that buffer first. `onSubscribe` and `onUnsubscribe` run as a subscription starts and ends, in every mode, and `ctx.subscriptionId` names it.

## Serve the event types from every server

Pass the extension in each server's `extensions` option; one `EventsExtension` serves every server constructed with it.

```ts source="../../examples/guides/servers/events.examples.ts#extensions"
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

const handler = createMcpHandler(() => new McpServer({ name: 'helpdesk', version: '1.0.0' }, { extensions: [events] }));
```

While it is constructed, each server advertises the extension and calls its `setup`, which registers the `events/*` methods (see [Extensions](../advanced/extensions.md)). Push streams under every `responseMode`, `'json'` included, as `subscriptions/listen` does. On a host that buffers whole responses push cannot work: the SDK's client falls back to poll once its first push stream times out, or set `delivery: { push: false }` on the event type so clients choose poll at once.

A push stream carries no SSE comment keepalive. The server sends `notifications/events/heartbeat` whenever the stream has been quiet for the granted interval, `heartbeatMs` (30 seconds by default) or a shorter one the client asks for, and the SDK's client reconnects after three intervals of silence. Keep `heartbeatMs` below your load balancer's idle timeout.

Both hold under `createMcpHandler`. A custom HTTP entry built directly on `PerRequestHTTPServerTransport` must stream `events/stream` itself: serve it with `responseMode` `'auto'` or `'sse'`, never `'json'`, and the transport's `keepAliveMs` applies to it as to any stream.

One `EventsExtension` serves at most `maxSubscriptions` subscriptions at once, 1024 by default, counting its poll leases, push streams and the webhook subscriptions this process handles; it refuses more with `resourceExhausted` (`data.limit: 'subscriptions'`). With `getPrincipal` set, each principal may hold a quarter of them, and so may all callers without a principal together, refused past that with `data.limit: 'principalSubscriptions'`; without `getPrincipal` only the process-wide limit applies.

## Deliver events to webhooks

Set `webhookTtlMs`, `webhookSender` and `getPrincipal` together to offer webhook delivery.

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

Setting `webhookTtlMs` or `webhookSender` without the other two throws `TypeError`. `getPrincipal` has no default, since `AuthInfo` has no subject field: return the user from wherever your token verifier puts it. A webhook subscription for which `getPrincipal` returns `null` is refused with `forbidden`, on stdio too; poll and push use the principal when there is one.

`webhookTtlMs` is the longest a webhook subscription lives without a refresh, and clients refresh before it lapses. The SDK verifies each endpoint with a challenge before the first delivery, signs every POST (Standard Webhooks), and retries a failed delivery up to five attempts in all. It keeps at most ten event deliveries per subscription in progress, waits between retries included, so a replayed backlog goes out ten at a time. It sends each destination host one challenge at a time, so a subscribe waits while another challenge to that host is in flight, and at most ten in any 60 seconds; past that, or when ten subscribes already wait for the host, it refuses with `resourceExhausted` (`data.limit: 'verification'`; `data.retryAfterMs` says when to try again, and the SDK's client does). It answers a principal's subscribes to a URL whose challenge failed with that failure for 60 seconds, without another challenge. `nodeWebhookSender()` requires `https`, resolves the host at every send by querying DNS directly (so `/etc/hosts` does not apply; origins in `trustedOrigins` skip resolution), refuses IANA special-purpose addresses (loopback, private, link-local and the like) and connects only to the addresses it checked, IPv4 and IPv6; it follows no redirects and gives up after 5 seconds.

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

A store that outlives the process carries webhook subscriptions across a restart. Emit-only types keep delivering to the stored subscriptions, without a resubscribe or a new verification; a `check` type's loop starts again at the subscription's next refresh, from the cursor the client supplies.

A replica runs `onUnsubscribe` after its `delete()` resolved `true`. Replicas racing on a store whose `delete()` is not atomic may each run it for one subscription, so keep `onUnsubscribe` idempotent.

When a store read fails while `emit()` hands the event to its webhook subscriptions, the SDK lists them again, up to three tries within a few hundred milliseconds, and skips those it already reached. A store that keeps failing drops the emitted event for the webhook subscriptions it could not list, and the SDK reports the failure to `onerror`.

With a shared store, webhook subscribe, refresh, secret rotation and unsubscribe work on any replica, and `emit()` on any replica reaches every matching webhook subscription. Some state stays on one process:

- `emit()` reaches push streams and the poll buffer on the emitting process only. A poll, or a webhook subscribe that resumes from a cursor, that lands on another replica gets `truncated: true` and a fresh cursor.
- A webhook subscription to a `check` type runs its `check` loop on every replica that handled its subscribe or a refresh, so its receiver may get an event more than once (same `eventId`, different `webhook-id`); the SDK's client drops the repeats by `eventId`. Prefer emit-only types for webhook subscribers, or run one replica.
- `remove()` on one replica may skip `onUnsubscribe` for subscriptions another replica handled.
- Retries, the delivery watermark and `deliveryStatus` stay with the replica that delivers.

## End a subscription

`terminate` ends subscriptions with an `EventsError`, for example when the subscriber lost access.

```ts source="../../examples/guides/servers/events.examples.ts#terminate"
import { EventsError } from '@modelcontextprotocol/server/ext/events';

// Ends one subscription, by the id its hooks received as ctx.subscriptionId.
function revoke(subscriptionId: string): Promise<void> {
    return incidents.terminate(new EventsError('forbidden', 'Access revoked'), { subscriptionId });
}
```

Without `subscriptionId`, `terminate` ends every subscription of the type. The client gets the error in its mode's form (a poll error response, a push `terminated` notification, a webhook `terminated` POST), and the SDK's client ends its loop with it, unless it is `notFound` and the type is still offered in that mode. `terminate` reaches webhook subscriptions on every replica through the store, and push and poll subscriptions on this process only.

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
