import type {
    AnySchema,
    EventDeliveryMode,
    EventDescriptor,
    EventOccurrence,
    EventSubscriptionError,
    EventSubscriptionSpec,
    FetchLike,
    ListEventsResult,
    PollEventsResult,
    PollEventsResultEntry,
    SchemaOutput,
    ServerContext,
    StandardJSONSchemaV1,
    SubscribeEventResult,
    WebhookDeliveryStatus,
    WebhookUrlValidationOptions
} from '@modelcontextprotocol/core';
import {
    computeWebhookSignature,
    CURSOR_EXPIRED,
    EVENT_NOT_FOUND,
    EVENT_UNAUTHORIZED,
    generateWebhookSecret,
    INVALID_CALLBACK_URL,
    isPrivateAddress,
    isSafeWebhookUrl,
    normaliseHostname,
    parseSchema,
    ProtocolError,
    ProtocolErrorCode,
    standardSchemaToJsonSchema,
    SUBSCRIPTION_NOT_FOUND,
    TOO_MANY_SUBSCRIPTIONS,
    WEBHOOK_SIGNATURE_HEADER,
    WEBHOOK_SUBSCRIPTION_ID_HEADER,
    WEBHOOK_TIMESTAMP_HEADER
} from '@modelcontextprotocol/core';

import type { Server } from './server.js';

/**
 * DNS lookup function shape — matches `node:dns/promises` `lookup(hostname, {all: true})`.
 * Injectable for testing delivery-time SSRF validation.
 */
export type HostResolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

const defaultHostResolver: HostResolver = async hostname => {
    // Dynamic import keeps Cloudflare Workers builds free of a static `node:dns`
    // dependency. On runtimes without it, delivery-time validation degrades to
    // the subscribe-time hostname check; supply `webhook.resolveHost` explicitly
    // (or rely on the platform's own SSRF guards) for full DNS-rebinding cover.
    const { lookup } = await import('node:dns/promises');
    return lookup(hostname, { all: true });
};

/**
 * Result returned from an {@linkcode EventCheckCallback}.
 */
export interface EventCheckResult {
    /**
     * Events that have occurred since the provided cursor. May be empty.
     *
     * Per-event `cursor` is optional: when present, the SDK uses the application's
     * cursor verbatim; when absent, the SDK auto-assigns a per-event-name sequence
     * cursor. Either way, every event ends up with a unique opaque cursor on the
     * wire.
     */
    events: (Omit<EventOccurrence, 'eventId' | 'timestamp' | 'cursor'> & { cursor?: string; eventId?: string })[];
    /**
     * The new cursor representing the position after these events. The SDK
     * stores this internally per subscription and passes it back on the next
     * check call. Never exposed to clients.
     */
    cursor: string;
    /**
     * If `true`, more events are available and the SDK SHOULD invoke check()
     * again immediately without waiting for `nextPollSeconds`.
     */
    hasMore?: boolean;
    /**
     * Recommended seconds until the next check call. Allows the application to
     * dynamically adjust polling frequency.
     */
    nextPollSeconds?: number;
}

/**
 * The single "check for changes since cursor" function that backs all three
 * delivery modes (poll, push, webhook).
 *
 * @param params - Subscription parameters, validated against the event's `inputSchema`.
 * @param cursor - Resume position. `null` means bootstrap: return an empty `events`
 *   array and a fresh cursor representing "now".
 * @param ctx - Server context (session, auth, etc.).
 * @returns Events that occurred since `cursor`, plus the new cursor.
 * @throws `ProtocolError` with code {@linkcode CURSOR_EXPIRED} if the
 *   cursor is no longer valid. The SDK translates this into a per-subscription
 *   error and the client re-subscribes with `cursor: null`.
 */
export type EventCheckCallback<Params = Record<string, unknown>> = (
    params: Params,
    cursor: string | null,
    ctx: ServerContext
) => EventCheckResult | Promise<EventCheckResult>;

/**
 * Lifecycle hooks for events where the upstream source must be configured per
 * subscription (e.g., "watch this Slack channel").
 */
export interface EventSubscriptionHooks<Params = Record<string, unknown>> {
    /**
     * Called when a subscription with a given ID becomes active (first poll with
     * a null cursor, inclusion in a push stream, or `events/subscribe`).
     */
    onSubscribe?: (subscriptionId: string, params: Params, ctx: ServerContext) => void | Promise<void>;
    /**
     * Called when a subscription is torn down (push stream closed, webhook
     * unsubscribe/expiry, or first poll with a null cursor after a previous
     * active subscription with the same ID is replaced).
     */
    onUnsubscribe?: (subscriptionId: string, params: Params, ctx: ServerContext) => void | Promise<void>;
}

/**
 * Optional filter applied when {@linkcode ServerEventManager.emit} is called in
 * broadcast mode. Determines whether an emitted event matches a given
 * subscription's params.
 *
 * If omitted, broadcast emits are delivered to all active subscriptions of the
 * event type (no filtering).
 */
/**
 * Per-subscription delivery filter for broadcast emits.
 *
 * Called once per (event, subscription) pair before delivery. Return `true`
 * to deliver, `false` to skip. May return a `Promise<boolean>` so the
 * callback can do async work (e.g. an upstream permission check) before
 * deciding — the SDK awaits the result before delivering, giving the hook
 * the full responsibility for gating.
 *
 * The `ctx.subscriptionId` lets the callback correlate with side state
 * (e.g. a per-sub authz cache) so the same event can be filtered
 * differently across subscriptions whose params are identical.
 */
export type EventMatchCallback<Params = Record<string, unknown>> = (
    params: Params,
    data: Record<string, unknown>,
    ctx: { subscriptionId: string }
) => boolean | Promise<boolean>;

/**
 * Per-subscription payload-shaping hook applied to broadcast emits and replays
 * after {@linkcode EventMatchCallback | matches} returns `true`. Lets the
 * server author redact, expand, or otherwise reshape the event's `data` for a
 * specific subscriber based on their `params` (e.g. apply `redact_pii`, honour
 * an `expand` field). Returning the input unchanged is valid; returning a new
 * object replaces `data` for that subscriber only.
 */
export type EventTransformCallback<Params = Record<string, unknown>> = (
    params: Params,
    data: Record<string, unknown>,
    ctx: { subscriptionId: string }
) => Record<string, unknown> | Promise<Record<string, unknown>>;

/**
 * Configuration for {@linkcode server/mcp.McpServer.registerEvent | McpServer.registerEvent()}.
 */
export interface EventConfig<InputArgs extends AnySchema | undefined = undefined> {
    /**
     * Optional human-readable title.
     */
    title?: string;
    /**
     * Human-readable description of what this event represents and when it fires.
     */
    description?: string;
    /**
     * Zod schema for subscription parameters. Converted to JSON Schema and
     * exposed via `events/list` as `inputSchema`. Incoming params are validated
     * against this before the check callback is invoked.
     */
    inputSchema?: InputArgs;
    /**
     * Zod schema for the event payload (`data` field). Converted to JSON Schema
     * and exposed via `events/list` as `payloadSchema`. Not runtime-enforced —
     * purely advisory for clients.
     */
    payloadSchema?: AnySchema;
    /**
     * Lifecycle hooks for per-subscription upstream setup/teardown.
     */
    hooks?: InputArgs extends AnySchema ? EventSubscriptionHooks<SchemaOutput<InputArgs>> : EventSubscriptionHooks;
    /**
     * Filter applied on broadcast {@linkcode ServerEventManager.emit | emit()}.
     * If omitted, broadcast emits match every active subscription of this type.
     */
    matches?: InputArgs extends AnySchema ? EventMatchCallback<SchemaOutput<InputArgs>> : EventMatchCallback;
    /**
     * Per-subscription payload transform applied after {@linkcode matches}
     * accepts the event. Lets the author redact, expand, or reshape `data` for
     * a specific subscriber based on their params. If omitted, the event is
     * delivered as emitted.
     */
    transform?: InputArgs extends AnySchema ? EventTransformCallback<SchemaOutput<InputArgs>> : EventTransformCallback;
    /**
     * Bounded in-memory event log retained per event-name. Holds every
     * occurrence — emits and check-derived events — so that subscribers can
     * resume from any prior cursor and so that all delivery modes share a
     * single source of truth.
     *
     * Always on; supply this only to override the default capacity. The
     * `matches` callback still filters at delivery and replay time.
     */
    buffer?: {
        /**
         * Maximum number of events to retain. Oldest entries evict first.
         * Defaults to {@linkcode DEFAULT_BUFFER_CAPACITY}.
         */
        capacity?: number;
    };
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on `_meta` usage.
     */
    _meta?: Record<string, unknown>;
}

/**
 * A registered event type, returned from {@linkcode server/mcp.McpServer.registerEvent | McpServer.registerEvent()}.
 */
export interface RegisteredEvent {
    description?: string;
    inputSchema?: AnySchema;
    payloadSchema?: AnySchema;
    enabled: boolean;
    enable(): void;
    disable(): void;
    update(updates: { description?: string; enabled?: boolean }): void;
    remove(): void;
}

/**
 * Options controlling webhook behaviour in {@linkcode ServerEventManager}.
 */
export interface EventWebhookOptions {
    /**
     * TTL (milliseconds) applied to webhook subscriptions. Subscriptions expire
     * if not refreshed before this interval elapses. If unset, webhook mode is
     * disabled entirely.
     */
    ttlMs?: number;
    /**
     * Safety validation for callback URLs. See {@linkcode isSafeWebhookUrl}.
     */
    urlValidation?: WebhookUrlValidationOptions;
    /**
     * Number of delivery attempts before giving up on a single event.
     * Defaults to 3.
     */
    maxDeliveryAttempts?: number;
    /**
     * Delay (milliseconds) before the first retry. Subsequent retries double
     * this value (exponential backoff). Defaults to 1000ms.
     */
    initialRetryDelayMs?: number;
    /**
     * Optional override for the HTTP client used to POST webhook deliveries.
     * Useful for testing. Defaults to the global `fetch`.
     */
    fetch?: FetchLike;
    /**
     * DNS resolver invoked **on every delivery** to validate the callback host's
     * resolved address against private/loopback ranges (DNS-rebinding mitigation).
     * Defaults to `node:dns/promises` `lookup(hostname, {all: true})`. Override
     * for testing or to supply a caching resolver.
     */
    resolveHost?: HostResolver;
    /**
     * Extracts the caller's canonical principal identifier from the request
     * context (e.g., OAuth `sub`, API key ID). If this returns a non-empty
     * string, subscriptions are keyed by `(principal, delivery.url, id)`.
     * If it returns `undefined`, the server falls back to `(delivery.url, id)`
     * scoping.
     *
     * Defaults to `ctx.http?.authInfo?.clientId`.
     */
    getPrincipal?: (ctx: ServerContext) => string | undefined;
}

/**
 * Options controlling push-stream behaviour in {@linkcode ServerEventManager}.
 */
export interface EventPushOptions {
    /**
     * If `true`, the SDK runs an internal polling loop per push subscription,
     * calling the check callback at the event's recommended interval and pushing
     * any results. If `false`, only {@linkcode ServerEventManager.emit | emit()}
     * drives push delivery — the server author is responsible for emitting.
     *
     * Defaults to `true`.
     */
    pollDriven?: boolean;
    /**
     * Interval (milliseconds) between heartbeat notifications on a push stream.
     * Defaults to 30000ms (30 seconds).
     */
    heartbeatIntervalMs?: number;
}

/**
 * Options for {@linkcode ServerEventManager}.
 */
export interface ServerEventManagerOptions {
    /**
     * Maximum number of subscriptions per `events/poll` or `events/stream` request.
     * Rejects with {@linkcode TOO_MANY_SUBSCRIPTIONS} if exceeded.
     * Defaults to 100.
     */
    maxSubscriptionsPerRequest?: number;
    /**
     * Maximum number of webhook subscriptions held concurrently.
     * Rejects with {@linkcode TOO_MANY_SUBSCRIPTIONS} if exceeded.
     * Defaults to 1000.
     */
    maxWebhookSubscriptions?: number;
    /**
     * Push-stream behaviour.
     */
    push?: EventPushOptions;
    /**
     * Webhook behaviour. If omitted, webhook mode is disabled.
     */
    webhook?: EventWebhookOptions;
}

interface LogEntry {
    /** Insertion order, internal-only. Never exposed on the wire. */
    seq: number;
    /** Application-defined or SDK-auto-assigned cursor. Unique per event-name. */
    cursor: string;
    occurrence: EventOccurrence;
}

interface EventLog {
    capacity: number;
    entries: LogEntry[];
    /** Cursor → seq lookup for O(1) resume. */
    cursorMap: Map<string, number>;
    nextSeq: number;
    /** Per-event-name counter for SDK-auto-assigned cursors when the app omits one. */
    autoCursorCounter: number;
    /**
     * FIFO of check-derived cursors that were entered into `cursorMap` (pointing
     * at the log head at mint time) so push/webhook clients can resume from
     * them. Evicted oldest-first at the same `capacity` to bound memory.
     */
    checkCursorQueue: string[];
}

interface InternalRegisteredEvent {
    title?: string;
    description?: string;
    inputSchema?: AnySchema;
    payloadSchema?: AnySchema;
    hooks?: EventSubscriptionHooks;
    matches?: EventMatchCallback;
    transform?: EventTransformCallback;
    log: EventLog;
    _meta?: Record<string, unknown>;
    check: EventCheckCallback;
    enabled: boolean;
}

interface ActiveSubscription {
    id: string;
    eventName: string;
    params: Record<string, unknown>;
    /** Last delivered cursor — what the client sees and resumes from. */
    cursor: string | null;
    /** Internal cursor passed back to check() — never exposed. */
    internalCheckCursor: string | null;
    ctx: ServerContext;
}

interface PushStream {
    subscriptions: Map<string, ActiveSubscription>;
    ctx: ServerContext;
    pollTimers: Map<string, ReturnType<typeof setTimeout>>;
    heartbeatTimer?: ReturnType<typeof setInterval>;
    closed: boolean;
    resolve: () => void;
}

interface WebhookSubscription extends ActiveSubscription {
    /** The compound key this subscription is stored under in `_webhookSubs`. */
    key: string;
    /** True when keyed by principal; false when keyed by delivery URL. */
    principalScoped: boolean;
    url: string;
    secret: string;
    expiresAt: number;
    deliveryStatus: WebhookDeliveryStatus;
    pollTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_POLL_SECONDS = 30;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_MAX_SUBS_PER_REQUEST = 100;
const DEFAULT_MAX_WEBHOOK_SUBS = 1000;
const DEFAULT_MAX_EVENTS = 100;
const DEFAULT_BUFFER_CAPACITY = 1000;
/** Spec floor for subscription-id entropy — approximates 122 bits when base64/hex encoded. */
const MIN_SUBSCRIPTION_ID_LENGTH = 16;

const EMPTY_OBJECT_JSON_SCHEMA = { type: 'object' as const, properties: {} };

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) if (a[k] !== b[k]) return false;
    return true;
}

/**
 * Manages event registration and delivery for an MCP server. Registers
 * handlers for `events/list`, `events/poll`, `events/stream`, `events/subscribe`,
 * and `events/unsubscribe`, and exposes {@linkcode emit | emit()} for direct
 * event publication.
 *
 * Normally you don't instantiate this directly — use
 * {@linkcode server/mcp.McpServer.registerEvent | McpServer.registerEvent()} and {@linkcode server/mcp.McpServer.emitEvent | McpServer.emitEvent()}.
 */
export class ServerEventManager {
    private _events = new Map<string, InternalRegisteredEvent>();
    private _pushStreams = new Set<PushStream>();
    private _webhookSubs = new Map<string, WebhookSubscription>();
    private _webhookReaper?: ReturnType<typeof setInterval>;
    private _handlersInitialized = false;
    private _eventCounter = 0;
    /**
     * Per-poll-subscription state, keyed by
     * `${principal-or-anon}\0${eventName}\0${sub.id}`. Tracks both:
     *
     * - `checkCursor`: where check() should resume on the next poll
     * - `lastSeenSeq`: highest log seq this client has been delivered (or
     *   acknowledged as "head" via bootstrap). Used when the client passes
     *   `cursor: null` on a follow-up poll so they keep getting incremental
     *   batches without replaying.
     *
     * Capped via simple FIFO eviction to bound memory.
     */
    private _pollState = new Map<string, { checkCursor: string | null; lastSeenSeq: number; lastReturnedCursor?: string }>();
    private static readonly _MAX_POLL_STATE = 10_000;

    private readonly _maxSubsPerRequest: number;
    private readonly _maxWebhookSubs: number;
    private readonly _pushOptions: Required<EventPushOptions>;
    private readonly _webhookOptions?: EventWebhookOptions;
    private readonly _fetch: FetchLike;
    private readonly _resolveHost: HostResolver;
    private readonly _getPrincipal: (ctx: ServerContext) => string | undefined;

    constructor(
        private readonly _server: Server,
        options: ServerEventManagerOptions = {}
    ) {
        this._maxSubsPerRequest = options.maxSubscriptionsPerRequest ?? DEFAULT_MAX_SUBS_PER_REQUEST;
        this._maxWebhookSubs = options.maxWebhookSubscriptions ?? DEFAULT_MAX_WEBHOOK_SUBS;
        this._pushOptions = {
            pollDriven: options.push?.pollDriven ?? true,
            heartbeatIntervalMs: options.push?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS
        };
        this._webhookOptions = options.webhook;
        this._fetch = options.webhook?.fetch ?? fetch;
        this._resolveHost = options.webhook?.resolveHost ?? defaultHostResolver;
        this._getPrincipal = options.webhook?.getPrincipal ?? (ctx => ctx.http?.authInfo?.clientId);
    }

    /**
     * Computes the compound subscription key used to store/look up webhook
     * subscriptions. `(principal, delivery.url, id)` when a principal is present,
     * otherwise `(delivery.url, id)`. `delivery.url` is part of the key in both
     * scopes and is therefore immutable for a subscription's lifetime — to change
     * endpoint, unsubscribe then resubscribe.
     */
    private _subscriptionKey(ctx: ServerContext, id: string, url: string): { key: string; principalScoped: boolean } {
        const principal = this._getPrincipal(ctx);
        if (principal) {
            return { key: `p:${principal}\0${url}\0${id}`, principalScoped: true };
        }
        return { key: `u:${url}\0${id}`, principalScoped: false };
    }

    /**
     * Registers an event type. Invoked indirectly via {@linkcode server/mcp.McpServer.registerEvent | McpServer.registerEvent()}.
     */
    register<InputArgs extends AnySchema | undefined>(
        name: string,
        config: EventConfig<InputArgs>,
        check: InputArgs extends AnySchema ? EventCheckCallback<SchemaOutput<InputArgs>> : EventCheckCallback
    ): RegisteredEvent {
        if (this._events.has(name)) {
            throw new Error(`Event ${name} is already registered`);
        }

        const entry: InternalRegisteredEvent = {
            title: config.title,
            description: config.description,
            inputSchema: config.inputSchema,
            payloadSchema: config.payloadSchema,
            hooks: config.hooks as EventSubscriptionHooks | undefined,
            matches: config.matches as EventMatchCallback | undefined,
            transform: config.transform as EventTransformCallback | undefined,
            log: {
                capacity: config.buffer?.capacity ?? DEFAULT_BUFFER_CAPACITY,
                entries: [],
                cursorMap: new Map(),
                nextSeq: 0,
                autoCursorCounter: 0,
                checkCursorQueue: []
            },
            _meta: config._meta,
            check: check as EventCheckCallback,
            enabled: true
        };
        this._events.set(name, entry);

        this._initializeHandlers();
        this._sendEventListChanged();

        const registered: RegisteredEvent = {
            description: entry.description,
            inputSchema: entry.inputSchema,
            payloadSchema: entry.payloadSchema,
            enabled: true,
            enable: () => registered.update({ enabled: true }),
            disable: () => registered.update({ enabled: false }),
            update: updates => {
                if (updates.description !== undefined) entry.description = updates.description;
                if (updates.enabled !== undefined) {
                    entry.enabled = updates.enabled;
                    registered.enabled = updates.enabled;
                }
                this._sendEventListChanged();
            },
            remove: () => {
                this._events.delete(name);
                this._sendEventListChanged();
            }
        };
        return registered;
    }

    /**
     * Emits an event to active subscriptions and appends it to the event log.
     * Two modes:
     *
     * - **Broadcast**: omit `subscriptionId`. The event is appended to the log
     *   and delivered to every active subscription of the given event type,
     *   filtered by the event's `matches` callback if one was provided.
     * - **Targeted**: provide `subscriptionId`. The event is delivered to that
     *   subscription only and is NOT appended to the log (it bypasses the
     *   broadcast log because it isn't addressed to other subscribers).
     *
     * The optional `cursor` lets applications use natural upstream identifiers
     * (Stripe event IDs, GitHub timestamps, etc.) as cursors. When omitted, the
     * SDK auto-assigns a per-event-name monotonic sequence cursor.
     */
    emit(
        eventName: string,
        data: Record<string, unknown>,
        options: { cursor?: string; eventId?: string; subscriptionId?: string } = {}
    ): void {
        const event = this._events.get(eventName);
        if (!event || !event.enabled) return;

        if (options.subscriptionId) {
            // Targeted emits go to the named subscription only and are not logged.
            const occurrence = this._makeOccurrence(
                eventName,
                data,
                undefined,
                options.cursor ?? this._mintAutoCursor(event),
                options.eventId
            );
            for (const stream of this._pushStreams) {
                const sub = stream.subscriptions.get(options.subscriptionId);
                if (sub && sub.eventName === eventName) this._deliverToPush(stream, sub, occurrence);
            }
            for (const sub of this._webhookSubs.values()) {
                if (sub.id === options.subscriptionId && sub.eventName === eventName) {
                    void this._deliverWebhook(sub, occurrence);
                }
            }
            return;
        }

        const occurrence = this._appendToLog(event, eventName, data, options.cursor, undefined, options.eventId);
        // matches() may be async (e.g. upstream authz check), so fan-out is
        // fire-and-forget. Within a single emit, matches-then-deliver for each
        // sub runs sequentially, preserving per-sub ordering for this event.
        // Across emits with async matches, apps that need strict ordering
        // should keep authz decisions cache-hot so matches resolves sync.
        this._fanOut(event, eventName, occurrence).catch(error => {
            // User-provided async matches() or delivery hooks may reject;
            // isolate from the caller's emit() path. Log so it's debuggable
            // rather than surfacing as an unhandled promise rejection.
            console.error(`[events] fan-out for ${eventName} failed:`, error);
        });
    }

    /** Appends to the event log with dedup-by-cursor; evicts oldest on overflow. */
    private _appendToLog(
        event: InternalRegisteredEvent,
        eventName: string,
        data: Record<string, unknown>,
        explicitCursor?: string,
        _meta?: Record<string, unknown>,
        eventId?: string
    ): EventOccurrence {
        const log = event.log;
        const cursor = explicitCursor ?? this._mintAutoCursor(event);
        const existing = log.cursorMap.get(cursor);
        if (existing !== undefined) {
            // Dedup: same cursor already in the log (e.g. check() returned an event we already have).
            const entry = log.entries.find(e => e.seq === existing);
            return entry?.occurrence ?? this._makeOccurrence(eventName, data, _meta, cursor, eventId);
        }
        const occurrence = this._makeOccurrence(eventName, data, _meta, cursor, eventId);
        const seq = log.nextSeq++;
        log.entries.push({ seq, cursor, occurrence });
        log.cursorMap.set(cursor, seq);
        if (log.entries.length > log.capacity) {
            const evicted = log.entries.shift()!;
            log.cursorMap.delete(evicted.cursor);
        }
        return occurrence;
    }

    private _mintAutoCursor(event: InternalRegisteredEvent): string {
        return `seq-${event.log.autoCursorCounter++}`;
    }

    private async _fanOut(event: InternalRegisteredEvent, eventName: string, occurrence: EventOccurrence): Promise<void> {
        for (const stream of this._pushStreams) {
            for (const sub of stream.subscriptions.values()) {
                if (sub.eventName !== eventName) continue;
                if (!(await this._safeMatches(event, sub.params, occurrence.data, sub.id))) continue;
                this._deliverToPush(stream, sub, await this._safeTransform(event, sub.params, occurrence, sub.id));
            }
        }
        for (const sub of this._webhookSubs.values()) {
            if (sub.eventName !== eventName) continue;
            if (!(await this._safeMatches(event, sub.params, occurrence.data, sub.id))) continue;
            void this._deliverWebhook(sub, await this._safeTransform(event, sub.params, occurrence, sub.id));
        }
    }

    /**
     * Evaluates the event's `matches` callback for a single subscription,
     * isolating any rejection so one sub's failing hook doesn't abort delivery
     * to its siblings (or surface as an unhandled rejection from a poll-loop
     * timer). Returns `false` on error so the event is skipped for that sub.
     */
    private async _safeMatches(
        event: InternalRegisteredEvent,
        params: Record<string, unknown>,
        data: Record<string, unknown>,
        subscriptionId: string
    ): Promise<boolean> {
        if (!event.matches) return true;
        try {
            return await event.matches(params, data, { subscriptionId });
        } catch (error) {
            console.error(`[events] matches() threw for subscription ${subscriptionId}:`, error);
            return false;
        }
    }

    /**
     * Applies the event's `transform` hook (if any) to produce a per-subscriber
     * payload. Returns the original occurrence when no transform is configured
     * or when the hook throws (falling back to deliver-as-emitted is safer than
     * dropping a matched event).
     */
    private async _safeTransform(
        event: InternalRegisteredEvent,
        params: Record<string, unknown>,
        occurrence: EventOccurrence,
        subscriptionId: string
    ): Promise<EventOccurrence> {
        if (!event.transform) return occurrence;
        try {
            const data = await event.transform(params, occurrence.data, { subscriptionId });
            return data === occurrence.data ? occurrence : { ...occurrence, data };
        } catch (error) {
            console.error(`[events] transform() threw for subscription ${subscriptionId}:`, error);
            return occurrence;
        }
    }

    private _deliverToPush(stream: PushStream, sub: ActiveSubscription, occurrence: EventOccurrence): void {
        sub.cursor = occurrence.cursor;
        this._sendEventNotification(stream, sub.id, occurrence);
    }

    /**
     * Terminates a single active subscription (push or webhook) by ID, optionally
     * with a reason. The server stops delivering events to that subscription and,
     * for push streams, sends a `notifications/events/terminated` notification so
     * the client can remove the subscription and notify the application.
     *
     * Use this when the user's access to an upstream resource is revoked mid-stream.
     */
    terminate(subscriptionId: string, reason?: string | EventSubscriptionError): void {
        const error: EventSubscriptionError =
            typeof reason === 'object' ? reason : { code: EVENT_UNAUTHORIZED, message: reason ?? 'Subscription terminated' };
        for (const stream of this._pushStreams) {
            const sub = stream.subscriptions.get(subscriptionId);
            if (sub) {
                if (!stream.closed) {
                    void stream.ctx.mcpReq.notify({
                        method: 'notifications/events/terminated',
                        params: { id: subscriptionId, error }
                    });
                }
                const timer = stream.pollTimers.get(subscriptionId);
                if (timer) clearTimeout(timer);
                stream.pollTimers.delete(subscriptionId);
                const event = this._events.get(sub.eventName);
                if (event?.hooks?.onUnsubscribe) {
                    void Promise.resolve(event.hooks.onUnsubscribe(sub.id, sub.params, stream.ctx)).catch(() => {});
                }
                stream.subscriptions.delete(subscriptionId);
            }
        }
        for (const [key, webhook] of this._webhookSubs) {
            if (webhook.id === subscriptionId) {
                void this._deliverWebhookError(webhook, error);
                void this._teardownWebhookSub(webhook);
                this._webhookSubs.delete(key);
            }
        }
    }

    /** Closes all active push streams and webhook poll loops. Called on server shutdown. */
    close(): void {
        for (const stream of this._pushStreams) this._closeStream(stream);
        this._pushStreams.clear();
        for (const sub of this._webhookSubs.values()) this._teardownWebhookSub(sub);
        this._webhookSubs.clear();
        if (this._webhookReaper) {
            clearInterval(this._webhookReaper);
            this._webhookReaper = undefined;
        }
    }

    private _initializeHandlers(): void {
        if (this._handlersInitialized) return;

        this._server.assertCanSetRequestHandler('events/list');
        this._server.assertCanSetRequestHandler('events/poll');
        this._server.assertCanSetRequestHandler('events/stream');

        this._server.registerCapabilities({
            events: {
                listChanged: this._server.getCapabilities().events?.listChanged ?? true
            }
        });

        this._server.setRequestHandler('events/list', (): ListEventsResult => this._handleList());
        this._server.setRequestHandler('events/poll', (req, ctx) => this._handlePoll(req.params, ctx));
        this._server.setRequestHandler('events/stream', (req, ctx) => this._handleStream(req.params, ctx));

        if (this._webhookOptions?.ttlMs) {
            this._server.assertCanSetRequestHandler('events/subscribe');
            this._server.assertCanSetRequestHandler('events/unsubscribe');
            this._server.setRequestHandler('events/subscribe', (req, ctx) => this._handleSubscribe(req.params, ctx));
            this._server.setRequestHandler('events/unsubscribe', (req, ctx) => this._handleUnsubscribe(req.params, ctx));
            // Periodic reaper for expired webhook subscriptions.
            const reapInterval = Math.max(1000, Math.min(this._webhookOptions.ttlMs / 4, 60_000));
            this._webhookReaper = setInterval(() => this._reapExpiredWebhooks(), reapInterval);
            if (typeof this._webhookReaper === 'object' && 'unref' in this._webhookReaper) {
                (this._webhookReaper as unknown as { unref: () => void }).unref();
            }
        }

        this._handlersInitialized = true;
    }

    private _sendEventListChanged(): void {
        if (this._server.transport) {
            void this._server.sendEventListChanged();
        }
    }

    private _computeDeliveryModes(): EventDeliveryMode[] {
        const modes: EventDeliveryMode[] = ['poll', 'push'];
        if (this._webhookOptions?.ttlMs) modes.push('webhook');
        return modes;
    }

    private _handleList(): ListEventsResult {
        const delivery = this._computeDeliveryModes();
        const events: EventDescriptor[] = [];
        for (const [name, event] of this._events) {
            if (!event.enabled) continue;
            events.push({
                name,
                title: event.title,
                description: event.description,
                delivery,
                inputSchema: event.inputSchema
                    ? (standardSchemaToJsonSchema(
                          event.inputSchema as unknown as StandardJSONSchemaV1,
                          'input'
                      ) as EventDescriptor['inputSchema'])
                    : EMPTY_OBJECT_JSON_SCHEMA,
                payloadSchema: event.payloadSchema
                    ? (standardSchemaToJsonSchema(
                          event.payloadSchema as unknown as StandardJSONSchemaV1,
                          'output'
                      ) as EventDescriptor['payloadSchema'])
                    : undefined,
                _meta: event._meta
            });
        }
        return { events };
    }

    private async _handlePoll(
        params: { subscriptions: EventSubscriptionSpec[]; maxEvents?: number },
        ctx: ServerContext
    ): Promise<PollEventsResult> {
        if (params.subscriptions.length > this._maxSubsPerRequest) {
            throw new ProtocolError(TOO_MANY_SUBSCRIPTIONS, `Too many subscriptions (max ${this._maxSubsPerRequest})`);
        }
        const maxEvents = params.maxEvents ?? DEFAULT_MAX_EVENTS;
        const results: PollEventsResultEntry[] = [];
        for (const spec of params.subscriptions) {
            results.push(await this._pollOne(spec, maxEvents, ctx));
        }
        return { results };
    }

    /**
     * Returns log entries with `seq > cursor`'s seq, filtered by the event's
     * `matches` callback. Used for resume-from-cursor across all three delivery
     * modes.
     *
     * - `cursor === null` → no replay (fresh subscribe from "now")
     * - `cursor` found in log → replay everything after it
     * - `cursor` not found → CursorExpired (the buffer has wrapped past it, or
     *   the cursor was never minted)
     */
    private async _replayAfterCursor(
        event: InternalRegisteredEvent,
        params: Record<string, unknown>,
        cursor: string | null,
        subscriptionId: string
    ): Promise<{ events: EventOccurrence[] } | { error: EventSubscriptionError }> {
        if (cursor === null) return { events: [] };
        const seq = event.log.cursorMap.get(cursor);
        if (seq === undefined) {
            return { error: { code: CURSOR_EXPIRED, message: 'Cursor not found in event log (re-subscribe to start from current head)' } };
        }
        const events: EventOccurrence[] = [];
        // Snapshot before iterating: matches() may be async, and a concurrent
        // emit() can `entries.shift()` the live array mid-iteration, which
        // makes the JS array iterator skip the next element silently.
        // eslint-disable-next-line unicorn/no-useless-spread -- intentional snapshot, not redundant
        for (const entry of [...event.log.entries]) {
            if (entry.seq <= seq) continue;
            if (!(await this._safeMatches(event, params, entry.occurrence.data, subscriptionId))) continue;
            events.push(await this._safeTransform(event, params, entry.occurrence, subscriptionId));
        }
        return { events };
    }

    /**
     * Runs check() and feeds results through the log + fan-out path. Returns
     * the new internal check cursor and any per-poll state (hasMore, nextPollSeconds).
     */
    private async _runCheckTick(
        event: InternalRegisteredEvent,
        eventName: string,
        params: Record<string, unknown>,
        internalCheckCursor: string | null,
        ctx: ServerContext
    ): Promise<
        | { events: EventOccurrence[]; nextInternalCheckCursor: string; nextPollSeconds?: number; hasMore?: boolean }
        | { error: EventSubscriptionError }
    > {
        let checkResult: EventCheckResult;
        try {
            checkResult = await event.check(params, internalCheckCursor, ctx);
        } catch (error) {
            return { error: this._toSubscriptionError(error) };
        }
        // check() runs per-subscription with that sub's params (and may be
        // scoped to its principal — e.g. Gmail returns one tenant's messages).
        // Results MUST stay local to the calling subscription. They are NOT
        // appended to the shared event log and NOT fanned out to other subs.
        // emit() retains broadcast semantics; check() does not.
        //
        // Their cursors ARE registered in `cursorMap` (pointing at the current
        // log head) so that a push/webhook client resuming from one finds it
        // and replays log entries since that point, instead of always seeing
        // CursorExpired. The cursors don't carry occurrences in `entries`, so
        // the data stays per-sub-private; only the seq anchor is shared.
        const headSeq = event.log.nextSeq - 1;
        const occurrences: EventOccurrence[] = checkResult.events.map(e => {
            const cursor = e.cursor ?? this._mintAutoCursor(event);
            if (!event.log.cursorMap.has(cursor)) {
                event.log.cursorMap.set(cursor, headSeq);
                event.log.checkCursorQueue.push(cursor);
                if (event.log.checkCursorQueue.length > event.log.capacity) {
                    event.log.cursorMap.delete(event.log.checkCursorQueue.shift()!);
                }
            }
            return this._makeOccurrence(e.name ?? eventName, e.data, e._meta, cursor, e.eventId);
        });
        return {
            events: occurrences,
            nextInternalCheckCursor: checkResult.cursor,
            nextPollSeconds: checkResult.nextPollSeconds,
            hasMore: checkResult.hasMore
        };
    }

    private async _pollOne(spec: EventSubscriptionSpec, maxEvents: number, ctx: ServerContext): Promise<PollEventsResultEntry> {
        const event = this._events.get(spec.name);
        if (!event || !event.enabled) {
            return { id: spec.id, error: { code: EVENT_NOT_FOUND, message: `Unknown event: ${spec.name}` } };
        }

        const paramsResult = await this._validateParams(event, spec.params);
        if ('error' in paramsResult) {
            return { id: spec.id, error: paramsResult.error };
        }

        const pollKey = this._pollStateKey(ctx, spec.name, spec.id);
        const existingState = this._pollState.get(pollKey);
        const wireCursor = spec.cursor ?? null;
        // Fire onSubscribe the first time we see this subscription id in the
        // poll state, regardless of cursor. A `sub --from <cursor>` is still
        // a fresh subscription from the server's perspective — it just wants
        // replay from a prior point. App-level hooks (e.g. authz) need to run.
        if (!existingState && event.hooks?.onSubscribe) {
            try {
                await event.hooks.onSubscribe(spec.id, paramsResult.params, ctx);
            } catch (error) {
                return { id: spec.id, error: this._toSubscriptionError(error) };
            }
            // Persist minimal state immediately so a check() failure or
            // CursorExpired below doesn't cause the next poll to see no state
            // and re-fire onSubscribe (leaking refcounts, authz registrations).
            this._setPollState(pollKey, { checkCursor: null, lastSeenSeq: event.log.nextSeq - 1 });
        }

        // Determine replay-from seq:
        // - explicit wireCursor → look up in cursorMap, CursorExpired if missing
        // - no wireCursor + existing state → resume from state.lastSeenSeq
        // - no wireCursor + first poll → start from current head (skip pre-existing log entries)
        let replayFromSeq: number;
        if (wireCursor !== null) {
            const seq = event.log.cursorMap.get(wireCursor);
            if (seq !== undefined) {
                replayFromSeq = seq;
            } else if (existingState && existingState.lastReturnedCursor === wireCursor) {
                // Cursor was a check-derived passthrough we returned previously
                // (check() results never enter the shared log). Resume from the
                // sub's persisted log position; the saved checkCursor below
                // will pick up the check stream where it left off.
                replayFromSeq = existingState.lastSeenSeq;
            } else {
                // Reset only the parts of state that pin a stale cursor. We
                // keep the entry itself so onSubscribe doesn't re-fire on the
                // client's retry-with-cursor=null.
                this._setPollState(pollKey, { checkCursor: null, lastSeenSeq: event.log.nextSeq - 1 });
                return {
                    id: spec.id,
                    error: { code: CURSOR_EXPIRED, message: 'Cursor not found in event log (re-subscribe to start from current head)' }
                };
            }
        } else if (existingState) {
            replayFromSeq = existingState.lastSeenSeq;
        } else {
            // Fresh poll-sub: start from current head — log entries inserted before
            // first poll are skipped (consistent with "subscribe from now").
            replayFromSeq = event.log.nextSeq - 1;
        }

        // 1. Replay log entries with seq > replayFromSeq, filtered by matches.
        const replayEvents: EventOccurrence[] = [];
        // Snapshot before iterating: matches() may be async, and a concurrent
        // emit() can `entries.shift()` mid-iteration which skips elements.
        // eslint-disable-next-line unicorn/no-useless-spread -- intentional snapshot, not redundant
        for (const entry of [...event.log.entries]) {
            if (entry.seq <= replayFromSeq) continue;
            if (await this._safeMatches(event, paramsResult.params, entry.occurrence.data, spec.id)) {
                replayEvents.push(await this._safeTransform(event, paramsResult.params, entry.occurrence, spec.id));
            }
        }

        // 2. Run a check() tick to discover new events; they enter the log and
        //    fan out to other matching subs. Anything new this tick is also
        //    appended to replayEvents (deduped by cursor).
        const internalCheckCursor = existingState?.checkCursor ?? null;
        const tick = await this._runCheckTick(event, spec.name, paramsResult.params, internalCheckCursor, ctx);
        if ('error' in tick) {
            // Reset checkCursor so the next poll re-bootstraps instead of
            // looping on the same stale value. Preserve lastSeenSeq (set
            // above on first poll, or carried from existingState) so log
            // replay position isn't lost.
            this._setPollState(pollKey, {
                checkCursor: tick.error.code === CURSOR_EXPIRED ? null : internalCheckCursor,
                lastSeenSeq: existingState?.lastSeenSeq ?? event.log.nextSeq - 1
            });
            return { id: spec.id, error: tick.error };
        }
        const replayCursors = new Set(replayEvents.map(e => e.cursor));
        for (const occ of tick.events) {
            if (replayCursors.has(occ.cursor)) continue;
            if (!(await this._safeMatches(event, paramsResult.params, occ.data, spec.id))) continue;
            replayEvents.push(await this._safeTransform(event, paramsResult.params, occ, spec.id));
        }

        const occurrences = replayEvents.slice(0, maxEvents);
        const hasMore = (tick.hasMore ?? false) || replayEvents.length > maxEvents;
        const newCursor = occurrences.length > 0 ? occurrences.at(-1)!.cursor : (wireCursor ?? undefined);

        // Compute new lastSeenSeq from the highest-seq entry we delivered, or
        // fall back to current head if nothing was delivered (so future polls
        // skip already-emitted-but-filtered events).
        const deliveredCursors = new Set(occurrences.map(o => o.cursor));
        let newLastSeen = replayFromSeq;
        for (const entry of event.log.entries) {
            if (deliveredCursors.has(entry.cursor) && entry.seq > newLastSeen) newLastSeen = entry.seq;
        }
        if (occurrences.length === 0) newLastSeen = Math.max(newLastSeen, event.log.nextSeq - 1);
        // Only persist `lastReturnedCursor` for check-derived cursors (not in
        // the log). Log-anchored cursors don't need passthrough because they
        // resolve via cursorMap; once evicted they MUST yield CursorExpired,
        // not silently fall through to existingState.
        const passthrough = newCursor !== undefined && !event.log.cursorMap.has(newCursor) ? newCursor : undefined;
        this._setPollState(pollKey, {
            checkCursor: tick.nextInternalCheckCursor,
            lastSeenSeq: newLastSeen,
            lastReturnedCursor: passthrough
        });
        return {
            id: spec.id,
            events: occurrences,
            cursor: newCursor,
            hasMore,
            nextPollSeconds: tick.nextPollSeconds ?? DEFAULT_POLL_SECONDS
        };
    }

    private _pollStateKey(ctx: ServerContext, eventName: string, subId: string): string {
        const principal = this._getPrincipal(ctx) ?? ctx.sessionId ?? 'anon';
        return `${principal}\0${eventName}\0${subId}`;
    }

    private _setPollState(key: string, value: { checkCursor: string | null; lastSeenSeq: number; lastReturnedCursor?: string }): void {
        if (this._pollState.has(key)) this._pollState.delete(key);
        this._pollState.set(key, value);
        while (this._pollState.size > ServerEventManager._MAX_POLL_STATE) {
            const oldest = this._pollState.keys().next().value;
            if (oldest === undefined) break;
            this._pollState.delete(oldest);
        }
    }

    private _handleStream(params: { subscriptions: EventSubscriptionSpec[] }, ctx: ServerContext): Promise<Record<string, never>> {
        if (params.subscriptions.length > this._maxSubsPerRequest) {
            throw new ProtocolError(TOO_MANY_SUBSCRIPTIONS, `Too many subscriptions (max ${this._maxSubsPerRequest})`);
        }

        return new Promise(resolve => {
            const stream: PushStream = {
                subscriptions: new Map(),
                ctx,
                pollTimers: new Map(),
                closed: false,
                resolve: () => resolve({})
            };

            void this._openStream(stream, params.subscriptions);

            ctx.mcpReq.signal.addEventListener('abort', () => this._closeStream(stream), { once: true });
            this._pushStreams.add(stream);
        });
    }

    private async _openStream(stream: PushStream, specs: EventSubscriptionSpec[]): Promise<void> {
        for (const spec of specs) {
            // The client can abort during any await in this loop; once
            // _closeStream has run, registering more subs would never balance
            // their onSubscribe with onUnsubscribe.
            if (stream.closed) return;
            const event = this._events.get(spec.name);
            if (!event || !event.enabled) {
                this._sendErrorNotification(stream, spec.id, { code: EVENT_NOT_FOUND, message: `Unknown event: ${spec.name}` });
                continue;
            }
            const paramsResult = await this._validateParams(event, spec.params);
            if ('error' in paramsResult) {
                this._sendErrorNotification(stream, spec.id, paramsResult.error);
                continue;
            }

            // Fire onSubscribe before replay so app hooks (e.g. authz that
            // registers the sub for matches()) are in place by the time
            // _replayAfterCursor runs its matches() filter. Resume via cursor
            // is still a fresh subscription (new spec.id) from the server's
            // perspective.
            if (event.hooks?.onSubscribe) {
                try {
                    await event.hooks.onSubscribe(spec.id, paramsResult.params, stream.ctx);
                } catch (error) {
                    this._sendErrorNotification(stream, spec.id, this._toSubscriptionError(error));
                    continue;
                }
            }

            const wireCursor = spec.cursor ?? null;
            const replay = await this._replayAfterCursor(event, paramsResult.params, wireCursor, spec.id);
            if ('error' in replay) {
                this._sendErrorNotification(stream, spec.id, replay.error);
                // onSubscribe ran above; balance it now since this spec won't
                // be added to stream.subscriptions and so _closeStream won't
                // call onUnsubscribe for it.
                await this._safeOnUnsubscribe(event, spec.id, paramsResult.params, stream.ctx);
                continue;
            }
            if (stream.closed) {
                await this._safeOnUnsubscribe(event, spec.id, paramsResult.params, stream.ctx);
                return;
            }

            const active: ActiveSubscription = {
                id: spec.id,
                eventName: spec.name,
                params: paramsResult.params,
                cursor: wireCursor,
                internalCheckCursor: null,
                ctx: stream.ctx
            };
            stream.subscriptions.set(spec.id, active);

            // Replay first; each delivery advances active.cursor naturally via _deliverToPush.
            for (const occ of replay.events) this._deliverToPush(stream, active, occ);
            this._sendActiveNotification(stream, spec.id, active.cursor ?? '');

            // Initial check tick — gives applications immediate-first-poll behavior
            // and lets the SDK pick up nextPollSeconds for subsequent ticks.
            let initialNextPoll: number | undefined;
            if (this._pushOptions.pollDriven) {
                const tick = await this._runCheckTick(event, spec.name, paramsResult.params, active.internalCheckCursor, stream.ctx);
                if ('error' in tick) {
                    this._sendErrorNotification(stream, spec.id, tick.error);
                } else {
                    active.internalCheckCursor = tick.nextInternalCheckCursor;
                    initialNextPoll = tick.nextPollSeconds;
                    for (const occ of tick.events) {
                        if (!(await this._safeMatches(event, active.params, occ.data, active.id))) continue;
                        this._deliverToPush(stream, active, await this._safeTransform(event, active.params, occ, active.id));
                    }
                }
                this._schedulePushPoll(stream, active, event, initialNextPoll);
            }
        }

        stream.heartbeatTimer = setInterval(() => {
            if (stream.closed) return;
            void stream.ctx.mcpReq.notify({ method: 'notifications/events/heartbeat', params: {} });
        }, this._pushOptions.heartbeatIntervalMs);
        if (typeof stream.heartbeatTimer === 'object' && 'unref' in stream.heartbeatTimer) {
            (stream.heartbeatTimer as unknown as { unref: () => void }).unref();
        }
    }

    private _schedulePushPoll(
        stream: PushStream,
        sub: ActiveSubscription,
        event: InternalRegisteredEvent,
        initialNextPollSeconds?: number
    ): void {
        let currentInterval = (initialNextPollSeconds ?? DEFAULT_POLL_SECONDS) * 1000;
        const tick = async () => {
            if (stream.closed) return;
            const result = await this._runCheckTick(event, sub.eventName, sub.params, sub.internalCheckCursor, stream.ctx);
            if ('error' in result) {
                this._sendErrorNotification(stream, sub.id, result.error);
                if (result.error.code === CURSOR_EXPIRED) {
                    sub.internalCheckCursor = null;
                    stream.pollTimers.set(sub.id, setTimeout(tick, currentInterval));
                } else {
                    await this._safeOnUnsubscribe(event, sub.id, sub.params, stream.ctx);
                    stream.subscriptions.delete(sub.id);
                }
                return;
            }
            sub.internalCheckCursor = result.nextInternalCheckCursor;
            // Filter check-derived events through this sub's matches and deliver.
            for (const occ of result.events) {
                if (!(await this._safeMatches(event, sub.params, occ.data, sub.id))) continue;
                this._deliverToPush(stream, sub, await this._safeTransform(event, sub.params, occ, sub.id));
            }
            if (result.nextPollSeconds !== undefined) currentInterval = result.nextPollSeconds * 1000;
            stream.pollTimers.set(sub.id, setTimeout(tick, result.hasMore ? 0 : currentInterval));
        };
        stream.pollTimers.set(sub.id, setTimeout(tick, currentInterval));
    }

    private _closeStream(stream: PushStream): void {
        if (stream.closed) return;
        stream.closed = true;
        for (const timer of stream.pollTimers.values()) clearTimeout(timer);
        stream.pollTimers.clear();
        if (stream.heartbeatTimer) clearInterval(stream.heartbeatTimer);
        // Lifecycle: onUnsubscribe for every active subscription.
        for (const sub of stream.subscriptions.values()) {
            const event = this._events.get(sub.eventName);
            if (event?.hooks?.onUnsubscribe) {
                void Promise.resolve(event.hooks.onUnsubscribe(sub.id, sub.params, stream.ctx)).catch(() => {});
            }
        }
        stream.subscriptions.clear();
        this._pushStreams.delete(stream);
        stream.resolve();
    }

    private async _handleSubscribe(
        params: {
            id: string;
            name: string;
            params?: Record<string, unknown>;
            delivery: { mode: 'webhook'; url: string; secret?: string };
            cursor?: string | null;
        },
        ctx: ServerContext
    ): Promise<SubscribeEventResult> {
        const ttl = this._webhookOptions!.ttlMs!;

        if (params.id.length < MIN_SUBSCRIPTION_ID_LENGTH) {
            throw new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                `Subscription id must be at least ${MIN_SUBSCRIPTION_ID_LENGTH} characters (use a UUIDv4 or similar high-entropy value)`
            );
        }

        const event = this._events.get(params.name);
        if (!event || !event.enabled) {
            throw new ProtocolError(EVENT_NOT_FOUND, `Unknown event: ${params.name}`);
        }

        const paramsResult = await this._validateParams(event, params.params);
        if ('error' in paramsResult) {
            throw new ProtocolError(paramsResult.error.code, paramsResult.error.message, paramsResult.error.data);
        }

        const urlCheck = isSafeWebhookUrl(params.delivery.url, this._webhookOptions?.urlValidation);
        if (!urlCheck.safe) {
            throw new ProtocolError(INVALID_CALLBACK_URL, urlCheck.reason ?? 'Callback URL rejected');
        }

        const { key, principalScoped } = this._subscriptionKey(ctx, params.id, params.delivery.url);
        const existing = this._webhookSubs.get(key);
        const isNew = !existing;
        if (isNew && this._webhookSubs.size >= this._maxWebhookSubs) {
            throw new ProtocolError(TOO_MANY_SUBSCRIPTIONS, `Webhook subscription limit (${this._maxWebhookSubs}) reached`);
        }

        // Refresh extends TTL for an existing subscription. It MUST NOT change
        // event identity (name or params) — onSubscribe (and any authz it
        // performs) only runs on create, so allowing identity to mutate on
        // refresh would let a client switch from a low-privilege event to a
        // high-privilege one without re-authorisation. To change event/params,
        // unsubscribe then resubscribe.
        if (existing && (existing.eventName !== params.name || !shallowEqual(existing.params, paramsResult.params))) {
            throw new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                'Refresh cannot change event name or params; unsubscribe then resubscribe'
            );
        }

        // Fire onSubscribe for new subscriptions BEFORE replay and BEFORE
        // registering in `_webhookSubs`, so app hooks (e.g. authz that
        // populates state matches() reads) are in place when replay runs its
        // matches() filter, and so a hook failure doesn't leave a half-
        // registered sub behind.
        if (isNew && event.hooks?.onSubscribe) {
            await event.hooks.onSubscribe(params.id, paramsResult.params, ctx);
        }

        // Cursor semantics: on a fresh sub, null = start from now. On refresh,
        // null = keep the server's current position; non-null = replace.
        let cursor: string | null;
        let backlog: EventOccurrence[] = [];
        if (existing && (params.cursor ?? null) === null) {
            cursor = existing.cursor;
        } else {
            const wireCursor = params.cursor ?? null;
            const replay = await this._replayAfterCursor(event, paramsResult.params, wireCursor, params.id);
            if ('error' in replay) {
                if (isNew) await this._safeOnUnsubscribe(event, params.id, paramsResult.params, ctx);
                throw new ProtocolError(replay.error.code, replay.error.message, replay.error.data);
            }
            backlog = replay.events;
            cursor = backlog.length > 0 ? backlog.at(-1)!.cursor : wireCursor;
        }

        const expiresAt = Date.now() + ttl;
        const sub: WebhookSubscription = existing ?? {
            id: params.id,
            key,
            principalScoped,
            eventName: params.name,
            params: paramsResult.params,
            cursor,
            internalCheckCursor: null,
            ctx,
            url: params.delivery.url,
            secret: params.delivery.secret ?? generateWebhookSecret(),
            expiresAt,
            deliveryStatus: { active: true, lastDeliveryAt: null, lastError: null }
        };

        sub.cursor = cursor;
        if (params.delivery.secret !== undefined) sub.secret = params.delivery.secret;
        sub.expiresAt = expiresAt;
        sub.ctx = ctx;
        const priorStatus = sub.deliveryStatus;
        sub.deliveryStatus = { ...sub.deliveryStatus, active: true, failedSince: null };

        if (isNew) {
            this._webhookSubs.set(key, sub);
        }

        // Run an initial check tick so applications get an immediate-first-poll
        // and so tests get a sane interval picked up from check()'s nextPollSeconds.
        // Live emits arrive via fan-out independently of this loop.
        let nextPollSeconds: number | undefined;
        const tick = await this._runCheckTick(event, params.name, paramsResult.params, sub.internalCheckCursor, ctx);
        if ('error' in tick) {
            // Surface as initial-delivery problem; subsequent ticks may still recover.
            void this._deliverWebhookError(sub, tick.error);
        } else {
            sub.internalCheckCursor = tick.nextInternalCheckCursor;
            nextPollSeconds = tick.nextPollSeconds;
            for (const occ of tick.events) {
                if (!(await this._safeMatches(event, sub.params, occ.data, sub.id))) continue;
                sub.cursor = occ.cursor;
                void this._deliverWebhook(sub, await this._safeTransform(event, sub.params, occ, sub.id));
            }
        }

        if (isNew && this._pushOptions.pollDriven) {
            this._scheduleWebhookPoll(sub, event, nextPollSeconds);
        }

        for (const occ of backlog) {
            sub.cursor = occ.cursor;
            void this._deliverWebhook(sub, occ);
        }

        return {
            id: params.id,
            secret: isNew ? sub.secret : undefined,
            refreshBefore: new Date(expiresAt).toISOString(),
            deliveryStatus: isNew ? undefined : priorStatus
        };
    }

    private async _handleUnsubscribe(
        params: { id: string; delivery: { url: string } },
        ctx: ServerContext
    ): Promise<Record<string, never>> {
        const { key } = this._subscriptionKey(ctx, params.id, params.delivery.url);
        const sub = this._webhookSubs.get(key);
        if (!sub) {
            throw new ProtocolError(SUBSCRIPTION_NOT_FOUND, `Unknown subscription: ${params.id}`);
        }
        await this._teardownWebhookSub(sub, ctx);
        this._webhookSubs.delete(key);
        return {};
    }

    private _scheduleWebhookPoll(sub: WebhookSubscription, event: InternalRegisteredEvent, initialNextPollSeconds?: number): void {
        let currentInterval = (initialNextPollSeconds ?? DEFAULT_POLL_SECONDS) * 1000;
        const tick = async () => {
            if (!this._webhookSubs.has(sub.key)) return;
            if (!sub.deliveryStatus.active) {
                sub.pollTimer = setTimeout(tick, currentInterval);
                return;
            }
            const result = await this._runCheckTick(event, sub.eventName, sub.params, sub.internalCheckCursor, sub.ctx);
            if ('error' in result) {
                if (result.error.code === CURSOR_EXPIRED) {
                    void this._deliverWebhookError(sub, result.error);
                    sub.internalCheckCursor = null;
                }
                sub.pollTimer = setTimeout(tick, currentInterval);
                return;
            }
            sub.internalCheckCursor = result.nextInternalCheckCursor;
            for (const occ of result.events) {
                if (!(await this._safeMatches(event, sub.params, occ.data, sub.id))) continue;
                sub.cursor = occ.cursor;
                void this._deliverWebhook(sub, await this._safeTransform(event, sub.params, occ, sub.id));
            }
            if (result.nextPollSeconds !== undefined) currentInterval = result.nextPollSeconds * 1000;
            sub.pollTimer = setTimeout(tick, result.hasMore ? 0 : currentInterval);
        };
        sub.pollTimer = setTimeout(tick, currentInterval);
    }

    /**
     * Validates the callback URL's resolved address(es) against private/loopback
     * ranges at delivery time (DNS-rebinding mitigation), returning a possibly
     * rewritten target URL plus the `Host` header to send. For HTTP, the URL is
     * rewritten to the validated IP literal so the connection is pinned; for
     * HTTPS the original hostname is kept (TLS SNI/cert verification needs it),
     * leaving a small TOCTOU window between resolution and connect.
     */
    private async _resolveDeliveryTarget(rawUrl: string): Promise<{ url: string; host: string }> {
        const parsed = new URL(rawUrl);
        const host = parsed.host;
        if (!this._webhookOptions?.urlValidation?.allowPrivateNetworks) {
            const addresses = await this._resolveHost(parsed.hostname);
            for (const { address } of addresses) {
                if (isPrivateAddress(normaliseHostname(address))) {
                    throw new Error(`Callback host ${parsed.hostname} resolved to private/loopback address ${address}`);
                }
            }
            if (parsed.protocol === 'http:' && addresses[0]) {
                const addr = addresses[0].address;
                parsed.hostname = addresses[0].family === 6 ? `[${addr}]` : addr;
            }
        }
        return { url: parsed.toString(), host };
    }

    private async _postWebhook(sub: WebhookSubscription, body: string): Promise<void> {
        const maxAttempts = this._webhookOptions?.maxDeliveryAttempts ?? 3;
        let delay = this._webhookOptions?.initialRetryDelayMs ?? 1000;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const { url, host } = await this._resolveDeliveryTarget(sub.url);
                const timestamp = Math.floor(Date.now() / 1000);
                const signature = await computeWebhookSignature(sub.secret, timestamp, body);
                const res = await this._fetch(url, {
                    method: 'POST',
                    redirect: 'error',
                    headers: {
                        'Content-Type': 'application/json',
                        Host: host,
                        [WEBHOOK_SUBSCRIPTION_ID_HEADER]: sub.id,
                        [WEBHOOK_SIGNATURE_HEADER]: signature,
                        [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp)
                    },
                    body
                });
                if (res.ok) {
                    sub.deliveryStatus = { active: true, lastDeliveryAt: new Date().toISOString(), lastError: null, failedSince: null };
                    return;
                }
                throw new Error(`Webhook endpoint returned ${res.status} ${res.statusText}`);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (attempt >= maxAttempts) {
                    sub.deliveryStatus = {
                        active: false,
                        lastDeliveryAt: sub.deliveryStatus.lastDeliveryAt ?? null,
                        lastError: message,
                        failedSince: sub.deliveryStatus.failedSince ?? new Date().toISOString()
                    };
                    return;
                }
                await new Promise(r => setTimeout(r, delay));
                delay *= 2;
            }
        }
    }

    private _deliverWebhook(sub: WebhookSubscription, occurrence: EventOccurrence): Promise<void> {
        return this._postWebhook(sub, JSON.stringify({ id: sub.id, ...occurrence }));
    }

    /**
     * POSTs a signed error envelope (`{ id, error }`) to the callback URL when a
     * webhook subscription hits a terminal or recoverable error (CursorExpired,
     * server-initiated termination). The endpoint can use this to surface the
     * condition to the consuming client without waiting for the next refresh.
     */
    private _deliverWebhookError(sub: WebhookSubscription, error: EventSubscriptionError): Promise<void> {
        sub.deliveryStatus = { ...sub.deliveryStatus, lastError: error.message };
        return this._postWebhook(sub, JSON.stringify({ id: sub.id, error }));
    }

    private async _teardownWebhookSub(sub: WebhookSubscription, ctx?: ServerContext): Promise<void> {
        if (sub.pollTimer) clearTimeout(sub.pollTimer);
        const event = this._events.get(sub.eventName);
        if (event?.hooks?.onUnsubscribe) {
            await Promise.resolve(event.hooks.onUnsubscribe(sub.id, sub.params, ctx ?? sub.ctx)).catch(() => {});
        }
    }

    private _reapExpiredWebhooks(): void {
        const now = Date.now();
        for (const [key, sub] of this._webhookSubs) {
            if (sub.expiresAt <= now) {
                void this._teardownWebhookSub(sub);
                this._webhookSubs.delete(key);
            }
        }
    }

    private _sendEventNotification(stream: PushStream, id: string, occurrence: EventOccurrence): void {
        if (stream.closed) return;
        void stream.ctx.mcpReq.notify({
            method: 'notifications/events/event',
            params: { id, ...occurrence }
        });
    }

    private _sendActiveNotification(stream: PushStream, id: string, cursor: string): void {
        if (stream.closed) return;
        void stream.ctx.mcpReq.notify({
            method: 'notifications/events/active',
            params: { id, cursor }
        });
    }

    private _sendErrorNotification(stream: PushStream, id: string, error: EventSubscriptionError): void {
        if (stream.closed) return;
        void stream.ctx.mcpReq.notify({
            method: 'notifications/events/error',
            params: { id, error }
        });
    }

    private async _validateParams(
        event: InternalRegisteredEvent,
        params: Record<string, unknown> | undefined
    ): Promise<{ params: Record<string, unknown> } | { error: EventSubscriptionError }> {
        if (!event.inputSchema) {
            return { params: params ?? {} };
        }
        const parsed = parseSchema(event.inputSchema, params ?? {});
        if (!parsed.success) {
            const message = parsed.error.issues.map((i: { message: string }) => i.message).join(', ');
            return { error: { code: ProtocolErrorCode.InvalidParams, message: `Invalid subscription params: ${message}` } };
        }
        return { params: parsed.data as Record<string, unknown> };
    }

    private _makeOccurrence(
        name: string,
        data: Record<string, unknown>,
        _meta: Record<string, unknown> | undefined,
        cursor: string,
        eventId?: string
    ): EventOccurrence {
        return {
            eventId: eventId ?? `evt_${Date.now()}_${(this._eventCounter++).toString(36)}`,
            name,
            timestamp: new Date().toISOString(),
            data,
            cursor,
            _meta
        };
    }

    /**
     * Calls `onUnsubscribe` swallowing any error. Used on cleanup paths where
     * the hook MUST NOT prevent further teardown (or surface as the request
     * error in place of the original cause).
     */
    private async _safeOnUnsubscribe(
        event: InternalRegisteredEvent,
        subId: string,
        params: Record<string, unknown>,
        ctx: ServerContext
    ): Promise<void> {
        if (!event.hooks?.onUnsubscribe) return;
        try {
            await event.hooks.onUnsubscribe(subId, params, ctx);
        } catch {
            // Swallow — the caller is on a cleanup/error path already.
        }
    }

    private _toSubscriptionError(error: unknown): EventSubscriptionError {
        if (error instanceof ProtocolError) {
            return { code: error.code, message: error.message, data: error.data };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { code: ProtocolErrorCode.InternalError, message };
    }
}
