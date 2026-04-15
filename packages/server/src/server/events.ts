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
     */
    events: Omit<EventOccurrence, 'eventId' | 'timestamp' | 'cursor'>[];
    /**
     * The new cursor representing the position after these events.
     * The client (or SDK) will pass this back on the next check.
     */
    cursor: string;
    /**
     * If `true`, more events are available and the client SHOULD check again
     * immediately without waiting for `nextPollSeconds`.
     */
    hasMore?: boolean;
    /**
     * Recommended seconds until the next poll for this subscription.
     * Allows the server to dynamically adjust polling frequency.
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
export type EventMatchCallback<Params = Record<string, unknown>> = (params: Params, data: Record<string, unknown>) => boolean;

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
     * If set, {@linkcode ServerEventManager.emit | emit()} also appends to a
     * bounded in-memory ring buffer so poll-mode clients see emitted events on
     * their next `events/poll`. Without this, emits only reach push streams and
     * webhook subscriptions (poll is stateless from the server's perspective).
     *
     * The SDK wraps the check callback's cursor in a composite form to track
     * both the callback's position and the buffer's sequence number. Poll
     * clients whose buffer position falls behind the ring's oldest retained
     * entry receive `CursorExpired` and re-bootstrap.
     *
     * The `matches` callback still filters buffered emits at poll time.
     */
    bufferEmits?: {
        /** Maximum number of emitted events to retain. Oldest entries evict first. */
        capacity: number;
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

interface BufferedEmit {
    seq: number;
    occurrence: EventOccurrence;
}

interface EmitBuffer {
    capacity: number;
    entries: BufferedEmit[];
    nextSeq: number;
}

interface InternalRegisteredEvent {
    title?: string;
    description?: string;
    inputSchema?: AnySchema;
    payloadSchema?: AnySchema;
    hooks?: EventSubscriptionHooks;
    matches?: EventMatchCallback;
    buffer?: EmitBuffer;
    _meta?: Record<string, unknown>;
    check: EventCheckCallback;
    enabled: boolean;
}

/**
 * When `bufferEmits` is enabled, the SDK wraps the user's check-callback cursor
 * and the emit buffer's sequence number into a single opaque string so poll
 * clients can track both positions.
 */
interface CompositeCursor {
    /** The check callback's own cursor. */
    c: string;
    /** The emit buffer's sequence position (last-seen seq). */
    b: number;
}

function encodeCompositeCursor(cursor: CompositeCursor): string {
    return JSON.stringify(cursor);
}

function decodeCompositeCursor(raw: string): CompositeCursor | null {
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (
            parsed &&
            typeof parsed === 'object' &&
            typeof (parsed as CompositeCursor).c === 'string' &&
            typeof (parsed as CompositeCursor).b === 'number'
        ) {
            return parsed as CompositeCursor;
        }
    } catch {
        // fall through
    }
    return null;
}

interface ActiveSubscription {
    id: string;
    eventName: string;
    params: Record<string, unknown>;
    cursor: string;
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
/** Spec floor for subscription-id entropy — approximates 122 bits when base64/hex encoded. */
const MIN_SUBSCRIPTION_ID_LENGTH = 16;

const EMPTY_OBJECT_JSON_SCHEMA = { type: 'object' as const, properties: {} };

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
            buffer: config.bufferEmits ? { capacity: config.bufferEmits.capacity, entries: [], nextSeq: 0 } : undefined,
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
     * Emits an event directly to active subscriptions. Two modes:
     *
     * - **Broadcast**: omit `subscriptionId`. The SDK delivers to every active
     *   subscription (push or webhook) of the given event type, filtered by the
     *   event's `matches` callback if one was provided.
     * - **Targeted**: provide `subscriptionId`. The SDK delivers to exactly that
     *   subscription, skipping the match filter.
     *
     * Emitted events bypass the check callback — the server author is asserting
     * that this occurrence matches the subscription's params.
     */
    emit(eventName: string, data: Record<string, unknown>, options: { subscriptionId?: string } = {}): void {
        const event = this._events.get(eventName);
        if (!event || !event.enabled) return;

        const occurrence = this._makeOccurrence(eventName, data);

        // Broadcast emits are buffered so poll clients can see them. Targeted
        // emits are not — they address a specific push/webhook subscription.
        // Capture the assigned seq so live deliveries can carry a composite
        // cursor that resume logic understands (see _bootstrapFromCursor).
        let assignedSeq: number | null = null;
        if (event.buffer && !options.subscriptionId) {
            const buf = event.buffer;
            assignedSeq = buf.nextSeq;
            buf.entries.push({ seq: buf.nextSeq++, occurrence });
            if (buf.entries.length > buf.capacity) buf.entries.shift();
        }

        const liveCursor =
            assignedSeq !== null ? encodeCompositeCursor({ c: '', b: assignedSeq + 1 }) : occurrence.eventId;

        const deliverTo = (sub: ActiveSubscription, sink: 'push' | 'webhook', stream?: PushStream) => {
            if (options.subscriptionId && sub.id !== options.subscriptionId) return;
            if (!options.subscriptionId && event.matches && !event.matches(sub.params, data)) return;

            const withCursor: EventOccurrence = { ...occurrence, cursor: liveCursor };
            if (sink === 'push' && stream) {
                this._sendEventNotification(stream, sub.id, withCursor);
            } else if (sink === 'webhook') {
                void this._deliverWebhook(sub as WebhookSubscription, withCursor);
            }
        };

        for (const stream of this._pushStreams) {
            for (const sub of stream.subscriptions.values()) {
                if (sub.eventName === eventName) deliverTo(sub, 'push', stream);
            }
        }
        for (const sub of this._webhookSubs.values()) {
            if (sub.eventName === eventName) deliverTo(sub, 'webhook');
        }
    }

    /**
     * Terminates a single active subscription (push or webhook) by ID, optionally
     * with a reason. The server stops delivering events to that subscription and,
     * for push streams, sends a `notifications/events/terminated` notification so
     * the client can remove the subscription and notify the application.
     *
     * Use this when the user's access to an upstream resource is revoked mid-stream.
     */
    terminate(subscriptionId: string, reason?: string): void {
        for (const stream of this._pushStreams) {
            const sub = stream.subscriptions.get(subscriptionId);
            if (sub) {
                if (!stream.closed) {
                    void stream.ctx.mcpReq.notify({
                        method: 'notifications/events/terminated',
                        params: { id: subscriptionId, reason }
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
                void this._deliverWebhookError(webhook, { code: EVENT_UNAUTHORIZED, message: reason ?? 'Subscription terminated' });
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
                subscribe: true,
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
     * Shared bootstrap path for all three handlers (poll/push/webhook). Decodes
     * the composite cursor for buffered events, runs the check callback against
     * the unwrapped cursor, then merges any newer buffered emits. Returns the
     * resulting backlog (in occurrence order: check results first, then buffer)
     * and the new composite cursor that subsequent operations should resume from.
     */
    private async _bootstrapFromCursor(
        event: InternalRegisteredEvent,
        eventName: string,
        params: Record<string, unknown>,
        rawCursor: string | null,
        ctx: ServerContext
    ): Promise<
        | { backlog: EventOccurrence[]; cursor: string; nextPollSeconds?: number; hasMore?: boolean }
        | { error: EventSubscriptionError }
    > {
        const isBootstrap = rawCursor === null;

        let checkCursor: string | null;
        let bufferSeq: number;
        if (event.buffer) {
            if (isBootstrap) {
                checkCursor = null;
                bufferSeq = event.buffer.nextSeq; // "start from now" — skip all currently buffered emits
            } else {
                const composite = decodeCompositeCursor(rawCursor!);
                if (!composite) {
                    return { error: { code: CURSOR_EXPIRED, message: 'Cursor format is not valid for this event (re-bootstrap required)' } };
                }
                checkCursor = composite.c;
                bufferSeq = composite.b;
                const oldestSeq = event.buffer.entries[0]?.seq ?? event.buffer.nextSeq;
                if (bufferSeq < oldestSeq) {
                    return { error: { code: CURSOR_EXPIRED, message: 'Emit buffer has wrapped past this cursor (re-bootstrap required)' } };
                }
            }
        } else {
            checkCursor = rawCursor;
            bufferSeq = 0;
        }

        let checkResult: EventCheckResult;
        try {
            checkResult = await event.check(params, checkCursor, ctx);
        } catch (error) {
            return { error: this._toSubscriptionError(error) };
        }

        const checkOccurrences = checkResult.events.map(e => this._makeOccurrence(e.name ?? eventName, e.data, e._meta));

        const bufferOccurrences: EventOccurrence[] = [];
        let newBufferSeq = bufferSeq;
        if (event.buffer) {
            for (const entry of event.buffer.entries) {
                if (entry.seq < bufferSeq) continue;
                newBufferSeq = entry.seq + 1;
                if (event.matches && !event.matches(params, entry.occurrence.data)) continue;
                bufferOccurrences.push(entry.occurrence);
            }
        }

        const cursor = event.buffer ? encodeCompositeCursor({ c: checkResult.cursor, b: newBufferSeq }) : checkResult.cursor;
        return {
            backlog: [...checkOccurrences, ...bufferOccurrences],
            cursor,
            nextPollSeconds: checkResult.nextPollSeconds,
            hasMore: checkResult.hasMore
        };
    }

    /**
     * For the polling tick loops (push + webhook): unwrap a composite cursor
     * (if the event buffers) so we hand the check callback a stable check-cursor
     * value. Returns the bufferSeq separately so the caller can re-encode after
     * the check returns. Live emits are delivered through {@linkcode emit} and
     * never go through this loop.
     */
    private _decodeCursorForCheck(event: InternalRegisteredEvent, rawCursor: string | null): { checkCursor: string | null; bufferSeq: number } {
        if (!event.buffer) return { checkCursor: rawCursor, bufferSeq: 0 };
        if (rawCursor === null) return { checkCursor: null, bufferSeq: event.buffer.nextSeq };
        const composite = decodeCompositeCursor(rawCursor);
        if (!composite) return { checkCursor: null, bufferSeq: event.buffer.nextSeq };
        return { checkCursor: composite.c, bufferSeq: composite.b };
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

        const isBootstrap = (spec.cursor ?? null) === null;
        if (isBootstrap && event.hooks?.onSubscribe) {
            await event.hooks.onSubscribe(spec.id, paramsResult.params, ctx);
        }

        const result = await this._bootstrapFromCursor(event, spec.name, paramsResult.params, spec.cursor ?? null, ctx);
        if ('error' in result) {
            return { id: spec.id, error: result.error };
        }

        const occurrences = result.backlog.slice(0, maxEvents);
        const hasMore = (result.hasMore ?? false) || result.backlog.length > maxEvents;
        return {
            id: spec.id,
            events: occurrences,
            cursor: result.cursor,
            hasMore,
            nextPollSeconds: result.nextPollSeconds ?? DEFAULT_POLL_SECONDS
        };
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
        // Confirm/error each subscription.
        for (const spec of specs) {
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

            const bootstrap = await this._bootstrapFromCursor(event, spec.name, paramsResult.params, spec.cursor ?? null, stream.ctx);
            if ('error' in bootstrap) {
                this._sendErrorNotification(stream, spec.id, bootstrap.error);
                continue;
            }
            // Replay any backlog (check results + buffered emits since the cursor).
            for (const occ of bootstrap.backlog) {
                this._sendEventNotification(stream, spec.id, { ...occ, cursor: bootstrap.cursor });
            }

            if ((spec.cursor ?? null) === null && event.hooks?.onSubscribe) {
                await event.hooks.onSubscribe(spec.id, paramsResult.params, stream.ctx);
            }

            const active: ActiveSubscription = {
                id: spec.id,
                eventName: spec.name,
                params: paramsResult.params,
                cursor: bootstrap.cursor,
                ctx: stream.ctx
            };
            stream.subscriptions.set(spec.id, active);
            this._sendActiveNotification(stream, spec.id, bootstrap.cursor);

            if (this._pushOptions.pollDriven) {
                this._schedulePushPoll(stream, active, event, bootstrap.nextPollSeconds);
            }
        }

        // Heartbeat.
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
        const encode = (checkCursor: string, bufferSeq: number) =>
            event.buffer ? encodeCompositeCursor({ c: checkCursor, b: bufferSeq }) : checkCursor;
        const tick = async () => {
            if (stream.closed) return;
            try {
                const { checkCursor, bufferSeq } = this._decodeCursorForCheck(event, sub.cursor);
                const result = await event.check(sub.params, checkCursor, stream.ctx);
                const newCursor = encode(result.cursor, bufferSeq);
                for (const e of result.events) {
                    const occ = this._makeOccurrence(e.name ?? sub.eventName, e.data, e._meta);
                    occ.cursor = newCursor;
                    this._sendEventNotification(stream, sub.id, occ);
                }
                sub.cursor = newCursor;
                if (result.nextPollSeconds !== undefined) currentInterval = result.nextPollSeconds * 1000;
                stream.pollTimers.set(sub.id, setTimeout(tick, result.hasMore ? 0 : currentInterval));
            } catch (error) {
                const subErr = this._toSubscriptionError(error);
                this._sendErrorNotification(stream, sub.id, subErr);
                if (subErr.code === CURSOR_EXPIRED) {
                    const reboot = await event.check(sub.params, null, stream.ctx);
                    sub.cursor = encode(reboot.cursor, event.buffer?.nextSeq ?? 0);
                    if (reboot.nextPollSeconds !== undefined) currentInterval = reboot.nextPollSeconds * 1000;
                    stream.pollTimers.set(sub.id, setTimeout(tick, currentInterval));
                } else {
                    stream.subscriptions.delete(sub.id);
                }
            }
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

        // Cursor semantics: on a fresh sub, null = bootstrap. On refresh, null =
        // keep the server's current position; non-null = replace.
        let cursor: string;
        let backlog: EventOccurrence[] = [];
        let bootNextPollSeconds: number | undefined;
        if (existing && (params.cursor ?? null) === null) {
            cursor = existing.cursor;
        } else {
            const bootstrap = await this._bootstrapFromCursor(event, params.name, paramsResult.params, params.cursor ?? null, ctx);
            if ('error' in bootstrap) {
                throw new ProtocolError(bootstrap.error.code, bootstrap.error.message, bootstrap.error.data);
            }
            cursor = bootstrap.cursor;
            backlog = bootstrap.backlog;
            bootNextPollSeconds = bootstrap.nextPollSeconds;
        }

        const expiresAt = Date.now() + ttl;
        const sub: WebhookSubscription = existing ?? {
            id: params.id,
            key,
            principalScoped,
            eventName: params.name,
            params: paramsResult.params,
            cursor,
            ctx,
            url: params.delivery.url,
            secret: params.delivery.secret ?? generateWebhookSecret(),
            expiresAt,
            deliveryStatus: { active: true, lastDeliveryAt: null, lastError: null }
        };

        // Upsert mutable fields. delivery.url is part of the key in all scopes
        // and therefore immutable; a different URL addresses a different sub.
        sub.eventName = params.name;
        sub.params = paramsResult.params;
        sub.cursor = cursor;
        // delivery.secret is server-minted by default; client supplies it only to override or rotate.
        if (params.delivery.secret !== undefined) sub.secret = params.delivery.secret;
        sub.expiresAt = expiresAt;
        sub.ctx = ctx;
        // Surface prior delivery health (including lastError) on this refresh,
        // then reactivate for subsequent deliveries.
        const priorStatus = sub.deliveryStatus;
        sub.deliveryStatus = { ...sub.deliveryStatus, active: true, failedSince: null };

        if (isNew) {
            this._webhookSubs.set(key, sub);
            if (event.hooks?.onSubscribe) {
                await event.hooks.onSubscribe(params.id, paramsResult.params, ctx);
            }
            if (this._pushOptions.pollDriven) {
                this._scheduleWebhookPoll(sub, event, bootNextPollSeconds);
            }
        }

        // Deliver any backlog from the bootstrap/resume (check + buffered emits).
        for (const occ of backlog) {
            void this._deliverWebhook(sub, { ...occ, cursor });
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
        const encode = (checkCursor: string, bufferSeq: number) =>
            event.buffer ? encodeCompositeCursor({ c: checkCursor, b: bufferSeq }) : checkCursor;
        const tick = async () => {
            if (!this._webhookSubs.has(sub.key)) return;
            if (!sub.deliveryStatus.active) {
                sub.pollTimer = setTimeout(tick, currentInterval);
                return;
            }
            try {
                const { checkCursor, bufferSeq } = this._decodeCursorForCheck(event, sub.cursor);
                const result = await event.check(sub.params, checkCursor, sub.ctx);
                const newCursor = encode(result.cursor, bufferSeq);
                for (const e of result.events) {
                    const occ = this._makeOccurrence(e.name ?? sub.eventName, e.data, e._meta);
                    occ.cursor = newCursor;
                    void this._deliverWebhook(sub, occ);
                }
                sub.cursor = newCursor;
                if (result.nextPollSeconds !== undefined) currentInterval = result.nextPollSeconds * 1000;
                sub.pollTimer = setTimeout(tick, result.hasMore ? 0 : currentInterval);
            } catch (error) {
                const subErr = this._toSubscriptionError(error);
                if (subErr.code === CURSOR_EXPIRED) {
                    void this._deliverWebhookError(sub, subErr);
                    const reboot = await event.check(sub.params, null, sub.ctx);
                    sub.cursor = encode(reboot.cursor, event.buffer?.nextSeq ?? 0);
                    if (reboot.nextPollSeconds !== undefined) currentInterval = reboot.nextPollSeconds * 1000;
                }
                sub.pollTimer = setTimeout(tick, currentInterval);
            }
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
                    headers: {
                        'Content-Type': 'application/json',
                        Host: host,
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
            params: { id, ...error }
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

    private _makeOccurrence(name: string, data: Record<string, unknown>, _meta?: Record<string, unknown>): EventOccurrence {
        return {
            eventId: `evt_${Date.now()}_${(this._eventCounter++).toString(36)}`,
            name,
            timestamp: new Date().toISOString(),
            data,
            _meta
        };
    }

    private _toSubscriptionError(error: unknown): EventSubscriptionError {
        if (error instanceof ProtocolError) {
            return { code: error.code, message: error.message, data: error.data };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { code: ProtocolErrorCode.InternalError, message };
    }
}
