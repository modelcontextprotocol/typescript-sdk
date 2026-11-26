import type { DeliveryMode } from '@modelcontextprotocol/core/ext/events';
import type { ServerContext, StandardSchemaWithJSON } from '@modelcontextprotocol/core-internal';
import type { EventsError } from '@modelcontextprotocol/core-internal/ext/events';

export type InferInput<S extends StandardSchemaWithJSON> = StandardSchemaWithJSON.InferInput<S>;
export type InferOutput<S extends StandardSchemaWithJSON> = StandardSchemaWithJSON.InferOutput<S>;

/**
 * The `ctx` of every event callback: the subscription it runs for. There is no
 * client request behind many calls (a webhook `check` timer, `emit()`, a lease
 * expiring), so it carries no request-scoped API.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export interface EventContext {
    /** The event type name. */
    readonly name: string;
    /** An opaque id the SDK assigns to the subscription; pass it to `terminate`. */
    readonly subscriptionId: string;
    /** The subscriber, from `getPrincipal`; `null` without one. */
    readonly principal: string | null;
    /** How the subscription's events are delivered. */
    readonly mode: DeliveryMode;
    /** Aborts when the request or the subscription ends. */
    readonly signal: AbortSignal;
}

/**
 * The `ctx` of `check`: an {@linkcode EventContext} plus the client's hints.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export interface CheckContext extends EventContext {
    /** Return at most this many events, and set `hasMore` when more are waiting. */
    readonly maxEvents?: number;
    /** The client wants no events older than this many milliseconds. */
    readonly maxAgeMs?: number;
}

/**
 * One event as an author produces it. The SDK fills `name` and `cursor`, and
 * `timestamp` when absent; `emit()` also fills `eventId` when absent.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export interface EventInput<P = Record<string, unknown>> {
    /** The upstream event's stable id, for deduplication: required in a `check` result; `emit()` generates one when absent. */
    eventId?: string;
    /**
     * ISO 8601 time the event happened, by which `maxAgeMs` judges a `check` event (an emitted event is aged from
     * its `emit()` call). Without it the SDK uses the time it read the event (the `check` run that returned it, or
     * the `emit()` call), so `maxAgeMs` cannot skip a `check` event without one.
     */
    timestamp?: string;
    /** The payload, valid against the event type's `payloadSchema`. */
    data: P;
    _meta?: Record<string, unknown>;
}

/**
 * What `check` returns: the events since the cursor it was given, and the cursor to resume from.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export interface EventResult<P = Record<string, unknown>> {
    /**
     * Each with an `eventId` that stays the same whenever `check` returns the event again, as a replay does; the SDK
     * drops an event without one (a non-empty string) and reports it to `onerror`.
     */
    events: Array<EventInput<P> & { eventId: string }>;
    /** Where the next `check` resumes; `null` when the upstream cannot resume. */
    cursor: string | null;
    /**
     * How long a poll client should wait before polling again. It is sent rounded up to whole milliseconds and at
     * most half of `pollSubscriptionTtlMs`; a value that is not a finite number sends `defaultNextPollMs`.
     */
    nextPollMs?: number;
    /** The upstream lost history since the cursor it was given. Ignored with `cursor: null`, which has no position to skip past. */
    truncated?: boolean;
    /** More events are waiting beyond `ctx.maxEvents`. */
    hasMore?: boolean;
}

export interface EventDefinitionBase<I extends StandardSchemaWithJSON, P extends StandardSchemaWithJSON> {
    description?: string;
    /** Schema for the subscription `arguments`; absent means any object. */
    inputSchema?: I;
    /** Schema for `data` in delivered events. It must describe an object, as `data` always is: any other JSON Schema root throws `TypeError`. */
    payloadSchema: P;
    _meta?: Record<string, unknown>;
    /**
     * Runs when a subscription starts, on the process that starts it. Throw an `EventsError` to refuse it. Other
     * processes (after a restart, or other replicas) deliver to a webhook subscription in a store that outlives the
     * process or is shared, refresh it and may end it (running `onUnsubscribe`) without running `onSubscribe`, so keep
     * what its delivery needs (an upstream watcher that calls `emit()`, say) outside any one process.
     */
    onSubscribe?(ctx: EventContext, args: InferOutput<I>): void | Promise<void>;
    /**
     * Runs when a subscription ends, by request, expiry or termination; keep it idempotent. For a webhook subscription
     * in a store that outlives the process or is shared, it may run on a process that never ran its `onSubscribe`,
     * on each of several replicas racing on a `delete()` that is not atomic, or not at all for a record the store
     * dropped first.
     */
    onUnsubscribe?(ctx: EventContext, args: InferOutput<I>): void | Promise<void>;
    /** Turns delivery modes off; every mode the server offers is on otherwise. */
    delivery?: { poll?: false; push?: false; webhook?: false };
}

/**
 * The default kind of event type: the SDK calls `check` to read what happened
 * since a cursor. After a disconnect or a restart, clients resume from their
 * cursor for as long as the upstream still accepts it.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export interface CheckEventDefinition<I extends StandardSchemaWithJSON, P extends StandardSchemaWithJSON>
    extends EventDefinitionBase<I, P> {
    emitOnly?: false;
    /**
     * The events since `cursor`, and the cursor to resume from. A subscription that starts from now begins with
     * a call with `cursor: null` whose events the SDK drops: it takes only the cursor returned. A type without
     * replay returns `cursor: null`, so after that first call the SDK calls `check` with `null` every time and
     * sends the events each call returns: return what happened since the previous call for the same
     * `ctx.subscriptionId`. Poll serves such a type one subscription per lease (principal, event name and
     * arguments), so clients that share a lease, as every caller does on a server without `getPrincipal`,
     * split its events between them, and a client's first poll on an existing lease can return events from
     * before it subscribed. A poll client that waits longer than `pollSubscriptionTtlMs` between polls starts
     * a new lease each time and gets nothing. Clients that need every event use push or webhook. Every mode sets
     * `ctx.maxEvents` (poll from the request, 100 by default, which the server caps at 1 000; push and webhook to
     * 100): return at most that many events and set `hasMore` when more are waiting. After a page with more
     * waiting that moved on (had events or a new cursor), push runs the next `check` at once, and webhook once
     * every event of that page has been acknowledged or abandoned.
     */
    check(ctx: CheckContext, args: InferOutput<I>, cursor: string | null): EventResult<InferInput<P>> | Promise<EventResult<InferInput<P>>>;
    match?: never;
    transform?: never;
}

/**
 * An event type fed by `emit()` on its handle. Poll clients read a bounded
 * in-memory buffer, and push and webhook subscriptions that pass a cursor
 * replay it first; events emitted before a restart are lost, and so is
 * anything older than the buffer holds.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export interface EmitOnlyEventDefinition<I extends StandardSchemaWithJSON, P extends StandardSchemaWithJSON>
    extends EventDefinitionBase<I, P> {
    emitOnly: true;
    check?: never;
    /** Whether a broadcast event goes to a subscription with these arguments; absent means every subscription. */
    match?(ctx: EventContext, event: EventInput<InferOutput<P>>, args: InferOutput<I>): boolean;
    /** The event as this subscription receives it. */
    transform?(ctx: EventContext, event: EventInput<InferOutput<P>>, args: InferOutput<I>): EventInput<InferOutput<P>>;
}

/**
 * An event type definition: `check` for the default kind, or `emitOnly: true`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type EventDefinition<I extends StandardSchemaWithJSON, P extends StandardSchemaWithJSON> =
    | CheckEventDefinition<I, P>
    | EmitOnlyEventDefinition<I, P>;

/**
 * The handle `registerEvent` returns.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export interface EventHandle {
    readonly name: string;
    /**
     * Changes the listed fields; live subscriptions continue. Only additive
     * schema changes belong here: register the name again for a breaking one.
     */
    update(
        changes: Partial<
            Pick<
                EventDefinitionBase<StandardSchemaWithJSON, StandardSchemaWithJSON>,
                'description' | 'inputSchema' | 'payloadSchema' | '_meta'
            >
        >
    ): void;
    /** Stops offering the event type and ends its subscriptions with a `notFound` error. */
    remove(): void;
    /**
     * Ends one subscription (`options.subscriptionId`), or every subscription of the type, with `error`. A push
     * stream whose client has more than 1 MiB unread, or reaches that while its last messages go out, gets no
     * `terminated` notification: it is abandoned at once and its unread bytes dropped. Its response body errors, which
     * a runtime serving the web `Response` turns into an aborted HTTP response; under `toNodeHandler` the response
     * ends once the client reads what its socket already holds, or closes when the client disconnects.
     */
    terminate(error: EventsError, options?: { subscriptionId?: string }): Promise<void>;
}

/**
 * The handle of an emit-only event type.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export interface EmitOnlyEventHandle<P> extends EventHandle {
    /**
     * Publishes one event to every subscription whose `match` accepts it (every subscription without `match`),
     * shaped per subscription by `transform`. Route an event meant for one subscriber with `match`, on the
     * subscription's arguments or `ctx.principal`.
     */
    emit(input: EventInput<P>): Promise<void>;
}

/**
 * One webhook POST for a {@linkcode WebhookSender} to send.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export interface WebhookSendRequest {
    url: string;
    headers: Readonly<Record<string, string>>;
    body: string;
    /** The URL's origin is in `trustedOrigins`, so the `https` and private-address rules do not apply. */
    trusted: boolean;
    /** Aborts when the SDK stops delivering to the subscription. */
    signal: AbortSignal;
}

/**
 * The receiver's answer, or why there was none.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type WebhookSendOutcome = { status: number; body: string } | { error: 'connection_refused' | 'timeout' | 'tls_error' };

/**
 * Sends webhook POSTs. Webhook delivery is on only when one is configured.
 * It sends the request as given, follows no redirects, and gives up after its
 * own timeout with `{ error: 'timeout' }`: the SDK waits as long as it takes.
 * It should resolve rather than reject; an event delivery whose sender rejects
 * is reported to `onerror` and retried.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type WebhookSender = (request: WebhookSendRequest) => Promise<WebhookSendOutcome>;

/**
 * A stored webhook subscription.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export interface WebhookSubscriptionRecord {
    id: string;
    principal: string;
    name: string;
    /** The subscription arguments as the client sent them (JSON); the SDK parses them with the event type's `inputSchema` before it passes them to a callback. */
    arguments: Record<string, unknown>;
    url: string;
    secret: string;
    previousSecret?: { secret: string; expiresAt: number };
    expiresAt: number;
    createdAt: number;
}

/**
 * Where webhook subscriptions live. Records hold webhook secrets: protect the
 * storage accordingly. The SDK treats a record with `expiresAt <= now` as
 * expired: it deletes it and calls the event type's `onUnsubscribe`, so a
 * store that drops records itself should keep each one a while past
 * `expiresAt`. Several server replicas may share one store.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export interface WebhookSubscriptionStore {
    get(id: string): Promise<WebhookSubscriptionRecord | undefined>;
    put(record: WebhookSubscriptionRecord): Promise<void>;
    /** Resolves `true` when a record was deleted. */
    delete(id: string): Promise<boolean>;
    listByName(name: string): AsyncIterable<WebhookSubscriptionRecord>;
}

/**
 * Options for `new EventsExtension(options)`. Durations are in milliseconds;
 * every number must be positive and finite, and the counts
 * (`maxSubscriptions`, `emitBuffer.maxEvents`) and the durations clients
 * receive (`webhookTtlMs`, `heartbeatMs`, `defaultNextPollMs`) whole numbers.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export interface EventsOptions {
    /** The longest webhook subscription TTL granted. Set it with `webhookSender` (and `getPrincipal`) to turn webhook delivery on. */
    webhookTtlMs?: number;
    /** Sends webhook POSTs; set together with `webhookTtlMs`. */
    webhookSender?: WebhookSender;
    /** Where webhook subscriptions live; in memory by default. */
    webhookStore?: WebhookSubscriptionStore;
    /** Exact origins (`scheme://host:port`) exempt from the `https` and private-address rules for webhook URLs. For development. */
    trustedOrigins?: readonly string[];
    /** Who the request is from. Required for webhook delivery; poll and push use it when set. There is no default. */
    getPrincipal?: (ctx: ServerContext) => string | null | Promise<string | null>;
    /** Bounds of the in-memory buffer that emit-only event types are polled and replayed from. */
    emitBuffer?: { maxAgeMs?: number; maxEvents?: number };
    /** How long a poll subscription lives without a poll. Every `nextPollMs` sent is at most half of it. */
    pollSubscriptionTtlMs?: number;
    /** The push heartbeat interval granted when the client suggests none, and the longest granted. */
    heartbeatMs?: number;
    /**
     * The wait between two `check` runs of a push or webhook subscription, except after a page with more waiting
     * (`hasMore`) that made progress (it had events or a new cursor): push runs the next `check` at once, and webhook as
     * soon as every event of that page has been acknowledged or abandoned.
     */
    checkIntervalMs?: number;
    /** The `nextPollMs` sent when `check` gives none, capped at half of `pollSubscriptionTtlMs`; setting it over that half throws `TypeError`. */
    defaultNextPollMs?: number;
    /**
     * The most subscriptions this process serves at once, counting poll leases, push streams and the webhook
     * subscriptions whose subscribe or refresh it handled or is still creating; more are refused with `resourceExhausted`
     * (`data.limit: 'subscriptions'`). With `getPrincipal` set, each principal may hold a quarter of them (at least
     * one), and so may all callers without a principal together; more are refused with
     * `data.limit: 'principalSubscriptions'`. Without `getPrincipal` only the process-wide limit applies.
     * @default 1024
     */
    maxSubscriptions?: number;
    /** Receives errors nothing else can report (dropped payloads, hook failures, invalid `x-mcp-header` annotations). Default: `console.warn`. */
    onerror?: (error: Error) => void;
}
