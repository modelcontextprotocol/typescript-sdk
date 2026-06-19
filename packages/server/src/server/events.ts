import type {
    AnySchema,
    EventDeliveryMode,
    EventDescriptor,
    EventOccurrence,
    EventSubscriptionError,
    FetchLike,
    ListEventsResult,
    PollEventsRequestParams,
    PollEventsResult,
    RequestId,
    SchemaOutput,
    ServerContext,
    StandardJSONSchemaV1,
    StreamEventsRequestParams,
    SubscribeEventRequestParams,
    SubscribeEventResult,
    UnsubscribeEventRequestParams,
    WebhookControlEnvelope,
    WebhookDeliveryStatus,
    WebhookLastError,
    WebhookUrlValidationOptions
} from '@modelcontextprotocol/core';
import {
    computeWebhookSignature,
    CURSOR_EXPIRED,
    decodeWebhookSecret,
    DELIVERY_MODE_UNSUPPORTED,
    EVENT_NOT_FOUND,
    EVENT_UNAUTHORIZED,
    INVALID_CALLBACK_URL,
    isPrivateAddress,
    isSafeWebhookUrl,
    normaliseHostname,
    parseSchema,
    ProtocolError,
    ProtocolErrorCode,
    standardSchemaToJsonSchema,
    SUBSCRIPTION_ID_META_KEY,
    SUBSCRIPTION_NOT_FOUND,
    TOO_MANY_SUBSCRIPTIONS,
    WEBHOOK_ID_HEADER,
    WEBHOOK_MAX_BODY_BYTES,
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
     * cursor.
     */
    events: (Omit<EventOccurrence, 'eventId' | 'timestamp' | 'cursor'> & { cursor?: string; eventId?: string })[];
    /**
     * The new cursor representing the position after these events. The SDK
     * stores this internally per subscription and passes it back on the next
     * check call. Never exposed to clients. `null` for non-replayable types.
     */
    cursor: string | null;
    /**
     * `true` if the supplied `cursor` fell outside upstream's retention window
     * and check() reset to a position it can serve from. The SDK signals this
     * via `truncated: true` on the wire. Prefer this over throwing
     * `CURSOR_EXPIRED`; throwing is still supported for back-compat and is
     * mapped to the same `truncated` outcome.
     */
    truncated?: boolean;
    /**
     * If `true`, more events are available and the SDK SHOULD invoke check()
     * again immediately without waiting for `nextPollMs`.
     */
    hasMore?: boolean;
    /**
     * Recommended milliseconds until the next check call.
     */
    nextPollMs?: number;
}

/**
 * The "check for changes since cursor" function that backs poll, push, and
 * webhook delivery.
 *
 * @param params - Subscription parameters, validated against the event's `inputSchema`.
 * @param cursor - Resume position. `null` means bootstrap: return an empty `events`
 *   array and a fresh cursor representing "now".
 * @param ctx - Server context (session, auth, etc.).
 * @returns Events that occurred since `cursor`, plus the new cursor.
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
     * Called when a subscription becomes active (first poll for a given
     * `(principal, name, params)`, an `events/stream` request, or a fresh
     * `events/subscribe`).
     */
    onSubscribe?: (subscriptionId: string, params: Params, ctx: ServerContext) => void | Promise<void>;
    /**
     * Called when a subscription is torn down (push stream closed, webhook
     * unsubscribe/expiry, or poll-state eviction).
     */
    onUnsubscribe?: (subscriptionId: string, params: Params, ctx: ServerContext) => void | Promise<void>;
}

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
     * Zod schema for subscription parameters.
     */
    inputSchema?: InputArgs;
    /**
     * Zod schema for the event payload (`data` field). Advisory only.
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
     * accepts the event.
     */
    transform?: InputArgs extends AnySchema ? EventTransformCallback<SchemaOutput<InputArgs>> : EventTransformCallback;
    /**
     * Declares this event type as emit-only — the upstream is push-only with
     * no cursor-addressable change feed. The check function is omitted; poll is
     * served from the SDK's ring buffer of recent emits, and `cursor: null` is
     * returned for non-replayable behaviour when the buffer is unavailable.
     */
    emitOnly?: boolean;
    /**
     * Bounded in-memory event log retained per event-name.
     */
    buffer?: {
        /**
         * Maximum number of events to retain. Oldest entries evict first.
         * Defaults to {@linkcode DEFAULT_BUFFER_CAPACITY}.
         */
        capacity?: number;
    };
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
     * TTL (milliseconds) applied to webhook subscriptions. If unset, webhook
     * mode is disabled entirely.
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
     */
    fetch?: FetchLike;
    /**
     * DNS resolver invoked **on every delivery** to validate the callback host's
     * resolved address against private/loopback ranges (DNS-rebinding mitigation).
     */
    resolveHost?: HostResolver;
    /**
     * Extracts the caller's canonical principal identifier from the request
     * context (e.g., OAuth `sub`, API key ID). `events/subscribe` and
     * `events/unsubscribe` MUST be called with an authenticated principal —
     * the server rejects with `-32012 Unauthorized` if this returns
     * `undefined`. Defaults to `ctx.http?.authInfo?.clientId`.
     */
    getPrincipal?: (ctx: ServerContext) => string | undefined;
}

/**
 * Options controlling push-stream behaviour in {@linkcode ServerEventManager}.
 */
export interface EventPushOptions {
    /**
     * If `true`, the SDK runs an internal polling loop per push subscription.
     * If `false`, only {@linkcode ServerEventManager.emit | emit()} drives push.
     * Defaults to `true`.
     */
    pollDriven?: boolean;
    /**
     * Interval (milliseconds) between heartbeat notifications. Defaults to 30s.
     */
    heartbeatIntervalMs?: number;
}

/**
 * Options for {@linkcode ServerEventManager}.
 */
export interface ServerEventManagerOptions {
    /**
     * Maximum number of webhook subscriptions held concurrently.
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
    seq: number;
    cursor: string;
    /** ms since epoch — used for `maxAgeMs` floor evaluation. */
    at: number;
    occurrence: EventOccurrence;
}

interface EventLog {
    capacity: number;
    entries: LogEntry[];
    cursorMap: Map<string, number>;
    nextSeq: number;
    autoCursorCounter: number;
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
    emitOnly: boolean;
    log: EventLog;
    _meta?: Record<string, unknown>;
    check: EventCheckCallback;
    enabled: boolean;
}

interface ActiveSubscription {
    /** Derived routing handle (push: `req:<requestId>`; webhook: `sub_<hex>`). */
    id: string;
    eventName: string;
    params: Record<string, unknown>;
    /** Last delivered/advanced cursor — what the client sees and resumes from. */
    cursor: string | null;
    /** Internal cursor passed back to check() — never exposed. */
    internalCheckCursor: string | null;
    ctx: ServerContext;
}

/** A push stream is one `events/stream` request — exactly one subscription. */
interface PushStream {
    requestId: RequestId;
    sub: ActiveSubscription;
    pollTimer?: ReturnType<typeof setTimeout>;
    heartbeatTimer?: ReturnType<typeof setInterval>;
    closed: boolean;
    resolve: () => void;
}

interface WebhookSubscription extends ActiveSubscription {
    key: string;
    url: string;
    /**
     * Secrets for HMAC signing. Newest first; up to two retained so the server
     * can dual-sign during rotation. Populated entirely from client-supplied
     * `delivery.secret` values across refreshes.
     */
    secrets: string[];
    /** Log seq at or before which all deliveries are acked or abandoned. */
    acknowledgedSeq: number;
    expiresAt: number;
    deliveryStatus: WebhookDeliveryStatus;
    pollTimer?: ReturnType<typeof setTimeout>;
}

interface PollLease {
    /** Derived id passed to lifecycle hooks. */
    id: string;
    checkCursor: string | null;
    lastSeenSeq: number;
    lastReturnedCursor?: string;
    params: Record<string, unknown>;
}

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_MAX_WEBHOOK_SUBS = 1000;
const DEFAULT_MAX_EVENTS = 100;
const DEFAULT_BUFFER_CAPACITY = 1000;

const EMPTY_OBJECT_JSON_SCHEMA = { type: 'object' as const, properties: {} };

const EMIT_ONLY_CHECK: EventCheckCallback = () => ({ events: [], cursor: null, nextPollMs: DEFAULT_POLL_MS });

/**
 * Stable JSON serialisation — sorts object keys recursively so two
 * semantically-identical params produce the same hash regardless of insertion
 * order.
 */
function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(v => canonicalJson(v)).join(',')}]`;
    const obj = value as Record<string, unknown>;
    // eslint-disable-next-line unicorn/no-array-sort -- Object.keys() returns a fresh array; in-place sort is fine and toSorted() needs ES2023 lib
    const keys = Object.keys(obj).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

async function sha256Hex(input: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
    let hex = '';
    for (const b of digest) hex += b.toString(16).padStart(2, '0');
    return hex;
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
     * Per-poll-subscription lease state, keyed by
     * `(principal-or-anon, name, canonicalHash(params))`. Drives `onSubscribe`
     * for poll mode and lets follow-up polls resume incrementally.
     */
    private _pollLeases = new Map<string, PollLease>();
    private static readonly _MAX_POLL_LEASES = 10_000;

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
     * Computes the compound subscription key `(principal, url, name, arguments)`
     * and the deterministic routing `id` derived from it. Webhook subscribe and
     * unsubscribe MUST be authenticated; throws `-32012 Unauthorized` otherwise.
     */
    private async _subscriptionKey(
        ctx: ServerContext,
        url: string,
        name: string,
        params: Record<string, unknown>
    ): Promise<{ key: string; id: string }> {
        const principal = this._getPrincipal(ctx);
        if (!principal) {
            throw new ProtocolError(EVENT_UNAUTHORIZED, 'events/subscribe requires an authenticated principal');
        }
        const key = `${principal}\0${url}\0${name}\0${canonicalJson(params)}`;
        const hash = await sha256Hex(key);
        return { key, id: `sub_${hash.slice(0, 16)}` };
    }

    /**
     * Registers an event type. Invoked indirectly via {@linkcode server/mcp.McpServer.registerEvent | McpServer.registerEvent()}.
     */
    register<InputArgs extends AnySchema | undefined>(
        name: string,
        config: EventConfig<InputArgs>,
        check?: InputArgs extends AnySchema ? EventCheckCallback<SchemaOutput<InputArgs>> : EventCheckCallback
    ): RegisteredEvent {
        if (this._events.has(name)) {
            throw new Error(`Event ${name} is already registered`);
        }
        if (!check && !config.emitOnly) {
            throw new Error(`Event ${name}: check callback is required unless emitOnly is set`);
        }

        const entry: InternalRegisteredEvent = {
            title: config.title,
            description: config.description,
            inputSchema: config.inputSchema,
            payloadSchema: config.payloadSchema,
            hooks: config.hooks as EventSubscriptionHooks | undefined,
            matches: config.matches as EventMatchCallback | undefined,
            transform: config.transform as EventTransformCallback | undefined,
            emitOnly: config.emitOnly ?? false,
            log: {
                capacity: config.buffer?.capacity ?? DEFAULT_BUFFER_CAPACITY,
                entries: [],
                cursorMap: new Map(),
                nextSeq: 0,
                autoCursorCounter: 0,
                checkCursorQueue: []
            },
            _meta: config._meta,
            check: (check as EventCheckCallback | undefined) ?? EMIT_ONLY_CHECK,
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
     *
     * - **Broadcast** (default): the event is appended to the log and delivered
     *   to every active subscription of the given event type, filtered by the
     *   event's `matches` callback if one was provided.
     * - **Targeted** (`subscriptionId` set): delivered to that subscription only
     *   and NOT appended to the log.
     */
    emit(
        eventName: string,
        data: Record<string, unknown>,
        options: { cursor?: string; eventId?: string; subscriptionId?: string } = {}
    ): void {
        const event = this._events.get(eventName);
        if (!event || !event.enabled) return;

        if (options.subscriptionId) {
            const occurrence = this._makeOccurrence(
                eventName,
                data,
                undefined,
                options.cursor ?? this._mintAutoCursor(event),
                options.eventId
            );
            for (const stream of this._pushStreams) {
                if (stream.sub.id === options.subscriptionId && stream.sub.eventName === eventName) {
                    this._deliverToPush(stream, occurrence);
                }
            }
            for (const sub of this._webhookSubs.values()) {
                if (sub.id === options.subscriptionId && sub.eventName === eventName) {
                    void this._deliverWebhook(sub, occurrence);
                }
            }
            return;
        }

        const occurrence = this._appendToLog(event, eventName, data, options.cursor, undefined, options.eventId);
        this._fanOut(event, eventName, occurrence).catch(error => {
            console.error(`[events] fan-out for ${eventName} failed:`, error);
        });
    }

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
            const entry = log.entries.find(e => e.seq === existing);
            return entry?.occurrence ?? this._makeOccurrence(eventName, data, _meta, cursor, eventId);
        }
        const occurrence = this._makeOccurrence(eventName, data, _meta, cursor, eventId);
        const seq = log.nextSeq++;
        log.entries.push({ seq, cursor, at: Date.now(), occurrence });
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
            if (stream.sub.eventName !== eventName) continue;
            if (!(await this._safeMatches(event, stream.sub.params, occurrence.data, stream.sub.id))) continue;
            this._deliverToPush(stream, await this._safeTransform(event, stream.sub.params, occurrence, stream.sub.id));
        }
        for (const sub of this._webhookSubs.values()) {
            if (sub.eventName !== eventName) continue;
            if (!(await this._safeMatches(event, sub.params, occurrence.data, sub.id))) continue;
            void this._deliverWebhook(sub, await this._safeTransform(event, sub.params, occurrence, sub.id));
        }
    }

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

    private async _safeTransform(
        event: InternalRegisteredEvent,
        params: Record<string, unknown>,
        occurrence: EventOccurrence,
        subscriptionId: string
    ): Promise<EventOccurrence | null> {
        if (!event.transform) return occurrence;
        try {
            const data = await event.transform(params, occurrence.data, { subscriptionId });
            return data === occurrence.data ? occurrence : { ...occurrence, data };
        } catch (error) {
            // Fail closed: a throwing transform must not leak the unredacted
            // payload to the subscriber. Drop this delivery.
            console.error(`[events] transform() threw for subscription ${subscriptionId}; dropping delivery:`, error);
            return null;
        }
    }

    private _deliverToPush(stream: PushStream, occurrence: EventOccurrence | null): void {
        if (occurrence === null || stream.closed) return;
        stream.sub.cursor = occurrence.cursor ?? stream.sub.cursor;
        void stream.sub.ctx.mcpReq.notify({
            method: 'notifications/events/event',
            params: { ...occurrence, _meta: { ...occurrence._meta, [SUBSCRIPTION_ID_META_KEY]: stream.requestId } }
        });
    }

    /**
     * Terminates a single active subscription (push or webhook) by its derived
     * routing id, optionally with a structured reason. The server stops
     * delivering events to that subscription, sends `notifications/events/terminated`
     * (push) or a `terminated` control envelope (webhook), and fires
     * `onUnsubscribe`.
     */
    terminate(subscriptionId: string, reason?: string | EventSubscriptionError): void {
        const error: EventSubscriptionError =
            typeof reason === 'object' ? reason : { code: EVENT_UNAUTHORIZED, message: reason ?? 'Subscription terminated' };
        for (const stream of this._pushStreams) {
            if (stream.sub.id === subscriptionId) {
                if (!stream.closed) {
                    void stream.sub.ctx.mcpReq.notify({
                        method: 'notifications/events/terminated',
                        params: { error, _meta: { [SUBSCRIPTION_ID_META_KEY]: stream.requestId } }
                    });
                }
                this._closeStream(stream);
            }
        }
        for (const [key, webhook] of this._webhookSubs) {
            if (webhook.id === subscriptionId) {
                void this._deliverWebhookControl(webhook, { type: 'terminated', error });
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

    /**
     * Computes the replay slice from the log for a given cursor and `maxAgeMs`
     * floor. Never errors — when the cursor isn't found or the floor advances
     * past it, returns `truncated: true` and resets to head.
     */
    private async _replayAfterCursor(
        event: InternalRegisteredEvent,
        params: Record<string, unknown>,
        cursor: string | null,
        maxAgeMs: number | undefined,
        subscriptionId: string
    ): Promise<{ events: EventOccurrence[]; truncated: boolean; headCursor: string | null }> {
        const log = event.log;
        const headCursor = log.entries.at(-1)?.cursor ?? null;
        if (cursor === null) return { events: [], truncated: false, headCursor };

        let truncated = false;
        const fromSeq = log.cursorMap.get(cursor);
        if (fromSeq === undefined) {
            // Cursor not in retention — reset to head and signal gap.
            return { events: [], truncated: true, headCursor };
        }

        // Apply maxAgeMs floor: skip entries older than now - maxAgeMs.
        const floorAt = maxAgeMs === undefined ? undefined : Date.now() - maxAgeMs;
        const events: EventOccurrence[] = [];
        // eslint-disable-next-line unicorn/no-useless-spread -- intentional snapshot, not redundant
        for (const entry of [...log.entries]) {
            if (entry.seq <= fromSeq) continue;
            if (floorAt !== undefined && entry.at < floorAt) {
                truncated = true;
                continue;
            }
            if (!(await this._safeMatches(event, params, entry.occurrence.data, subscriptionId))) continue;
            const transformed = await this._safeTransform(event, params, entry.occurrence, subscriptionId);
            if (transformed !== null) events.push(transformed);
        }
        return { events, truncated, headCursor };
    }

    /**
     * Runs check() for a subscription. Maps `CURSOR_EXPIRED` (legacy throw or
     * `truncated: true` from check()) into the gap model rather than an error.
     */
    private async _runCheckTick(
        event: InternalRegisteredEvent,
        eventName: string,
        params: Record<string, unknown>,
        internalCheckCursor: string | null,
        ctx: ServerContext
    ): Promise<
        | {
              events: EventOccurrence[];
              nextInternalCheckCursor: string | null;
              nextPollMs?: number;
              hasMore?: boolean;
              truncated: boolean;
          }
        | { error: EventSubscriptionError }
    > {
        let checkResult: EventCheckResult;
        try {
            checkResult = await event.check(params, internalCheckCursor, ctx);
        } catch (error) {
            const subErr = this._toSubscriptionError(error);
            if (subErr.code === CURSOR_EXPIRED) {
                // Legacy throw mapped to gap model: reset and continue.
                return { events: [], nextInternalCheckCursor: null, truncated: true };
            }
            return { error: subErr };
        }
        // check() results stay private to the calling subscription. Only their
        // cursors are anchored at log head so a resume from one finds it.
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
            nextPollMs: checkResult.nextPollMs,
            hasMore: checkResult.hasMore,
            truncated: checkResult.truncated ?? false
        };
    }

    private async _handlePoll(params: PollEventsRequestParams, ctx: ServerContext): Promise<PollEventsResult> {
        const event = this._events.get(params.name);
        if (!event || !event.enabled) {
            throw new ProtocolError(EVENT_NOT_FOUND, `Unknown event: ${params.name}`);
        }
        if (!this._computeDeliveryModes().includes('poll')) {
            throw new ProtocolError(DELIVERY_MODE_UNSUPPORTED, `Event ${params.name} does not support poll delivery`);
        }

        const paramsResult = await this._validateParams(event, params.arguments);
        if ('error' in paramsResult) {
            throw new ProtocolError(paramsResult.error.code, paramsResult.error.message, paramsResult.error.data);
        }

        const leaseKey = await this._pollLeaseKey(ctx, params.name, paramsResult.params);
        let lease = this._pollLeases.get(leaseKey);
        const wireCursor = params.cursor;
        let truncated = false;

        if (!lease) {
            const hash = await sha256Hex(leaseKey);
            const id = `poll_${hash.slice(0, 16)}`;
            if (event.hooks?.onSubscribe) {
                await event.hooks.onSubscribe(id, paramsResult.params, ctx);
            }
            lease = { id, checkCursor: null, lastSeenSeq: event.log.nextSeq - 1, params: paramsResult.params };
            this._setPollLease(leaseKey, lease, event, ctx);
        }

        // Determine replay-from seq.
        let replayFromSeq: number;
        if (wireCursor === null) {
            replayFromSeq = lease.lastSeenSeq;
        } else {
            const seq = event.log.cursorMap.get(wireCursor);
            if (seq !== undefined) {
                replayFromSeq = seq;
            } else if (lease.lastReturnedCursor === wireCursor) {
                replayFromSeq = lease.lastSeenSeq;
            } else {
                // Gap — reset to head.
                replayFromSeq = event.log.nextSeq - 1;
                truncated = true;
            }
        }

        // 1. Replay log entries with seq > replayFromSeq, filtered + maxAgeMs floor.
        const floorAt = params.maxAgeMs !== undefined && wireCursor !== null ? Date.now() - params.maxAgeMs : undefined;
        const replayEvents: EventOccurrence[] = [];
        // eslint-disable-next-line unicorn/no-useless-spread -- intentional snapshot, not redundant
        for (const entry of [...event.log.entries]) {
            if (entry.seq <= replayFromSeq) continue;
            if (floorAt !== undefined && entry.at < floorAt) {
                truncated = true;
                continue;
            }
            if (await this._safeMatches(event, paramsResult.params, entry.occurrence.data, lease.id)) {
                const transformed = await this._safeTransform(event, paramsResult.params, entry.occurrence, lease.id);
                if (transformed !== null) replayEvents.push(transformed);
            }
        }

        // 2. Run a check() tick.
        const tick = await this._runCheckTick(event, params.name, paramsResult.params, lease.checkCursor, ctx);
        if ('error' in tick) {
            throw new ProtocolError(tick.error.code, tick.error.message, tick.error.data);
        }
        truncated ||= tick.truncated;
        const replayCursors = new Set(replayEvents.map(e => e.cursor));
        for (const occ of tick.events) {
            if (occ.cursor !== null && replayCursors.has(occ.cursor)) continue;
            if (!(await this._safeMatches(event, paramsResult.params, occ.data, lease.id))) continue;
            const transformed = await this._safeTransform(event, paramsResult.params, occ, lease.id);
            if (transformed !== null) replayEvents.push(transformed);
        }

        const maxEvents = params.maxEvents ?? DEFAULT_MAX_EVENTS;
        const occurrences = replayEvents.slice(0, maxEvents);
        const hasMore = (tick.hasMore ?? false) || replayEvents.length > maxEvents;
        const newCursor = occurrences.at(-1)?.cursor ?? (truncated ? (event.log.entries.at(-1)?.cursor ?? null) : wireCursor);

        // Compute new lastSeenSeq.
        const deliveredCursors = new Set(occurrences.map(o => o.cursor));
        let newLastSeen = replayFromSeq;
        for (const entry of event.log.entries) {
            if (entry.cursor !== null && deliveredCursors.has(entry.cursor) && entry.seq > newLastSeen) newLastSeen = entry.seq;
        }
        if (occurrences.length === 0) newLastSeen = Math.max(newLastSeen, event.log.nextSeq - 1);
        const passthrough = newCursor !== null && newCursor !== undefined && !event.log.cursorMap.has(newCursor) ? newCursor : undefined;
        this._setPollLease(
            leaseKey,
            { ...lease, checkCursor: tick.nextInternalCheckCursor, lastSeenSeq: newLastSeen, lastReturnedCursor: passthrough },
            event,
            ctx
        );

        return {
            events: occurrences,
            cursor: newCursor ?? null,
            truncated,
            hasMore,
            nextPollMs: tick.nextPollMs ?? DEFAULT_POLL_MS
        };
    }

    private async _pollLeaseKey(ctx: ServerContext, eventName: string, params: Record<string, unknown>): Promise<string> {
        const principal = this._getPrincipal(ctx) ?? ctx.sessionId ?? 'anon';
        return `${principal}\0${eventName}\0${await sha256Hex(canonicalJson(params))}`;
    }

    private _setPollLease(key: string, value: PollLease, event: InternalRegisteredEvent, ctx: ServerContext): void {
        if (this._pollLeases.has(key)) this._pollLeases.delete(key);
        this._pollLeases.set(key, value);
        while (this._pollLeases.size > ServerEventManager._MAX_POLL_LEASES) {
            const oldestKey = this._pollLeases.keys().next().value;
            if (oldestKey === undefined) break;
            const evicted = this._pollLeases.get(oldestKey)!;
            this._pollLeases.delete(oldestKey);
            void this._safeOnUnsubscribe(event, evicted.id, evicted.params, ctx);
        }
    }

    private _handleStream(params: StreamEventsRequestParams, ctx: ServerContext): Promise<Record<string, never>> {
        return new Promise((resolve, reject) => {
            this._openStream(params, ctx, () => resolve({})).catch((error: unknown) => reject(error as Error));
        });
    }

    private async _openStream(spec: StreamEventsRequestParams, ctx: ServerContext, resolve: () => void): Promise<void> {
        const event = this._events.get(spec.name);
        if (!event || !event.enabled) {
            throw new ProtocolError(EVENT_NOT_FOUND, `Unknown event: ${spec.name}`);
        }
        if (!this._computeDeliveryModes().includes('push')) {
            throw new ProtocolError(DELIVERY_MODE_UNSUPPORTED, `Event ${spec.name} does not support push delivery`);
        }
        const paramsResult = await this._validateParams(event, spec.arguments);
        if ('error' in paramsResult) {
            throw new ProtocolError(paramsResult.error.code, paramsResult.error.message, paramsResult.error.data);
        }

        const requestId = ctx.mcpReq.id;
        const subId = `req:${String(requestId)}`;
        // Fire onSubscribe before replay so app hooks (authz that registers the
        // sub for matches()) are in place by the time replay runs its filter.
        if (event.hooks?.onSubscribe) {
            await event.hooks.onSubscribe(subId, paramsResult.params, ctx);
        }

        const stream: PushStream = {
            requestId,
            sub: {
                id: subId,
                eventName: spec.name,
                params: paramsResult.params,
                cursor: spec.cursor,
                internalCheckCursor: null,
                ctx
            },
            closed: false,
            resolve
        };
        ctx.mcpReq.signal.addEventListener('abort', () => this._closeStream(stream), { once: true });
        this._pushStreams.add(stream);

        const replay = await this._replayAfterCursor(event, paramsResult.params, spec.cursor, spec.maxAgeMs, subId);
        if (stream.closed) {
            await this._safeOnUnsubscribe(event, subId, paramsResult.params, ctx);
            return;
        }

        // Replay first; each delivery advances cursor naturally. When truncated,
        // the supplied cursor is invalid and we reset to head.
        for (const occ of replay.events) this._deliverToPush(stream, occ);
        if (replay.truncated || stream.sub.cursor === null) stream.sub.cursor = replay.headCursor;
        this._sendActiveNotification(stream, stream.sub.cursor, replay.truncated);

        // Initial check tick + ongoing poll loop.
        if (this._pushOptions.pollDriven) {
            let initialNextPoll: number | undefined;
            const tick = await this._runCheckTick(event, spec.name, paramsResult.params, null, ctx);
            if ('error' in tick) {
                this._sendErrorNotification(stream, tick.error);
            } else {
                stream.sub.internalCheckCursor = tick.nextInternalCheckCursor;
                initialNextPoll = tick.nextPollMs;
                if (tick.truncated) this._sendActiveNotification(stream, stream.sub.cursor, true);
                for (const occ of tick.events) {
                    if (!(await this._safeMatches(event, paramsResult.params, occ.data, subId))) continue;
                    this._deliverToPush(stream, await this._safeTransform(event, paramsResult.params, occ, subId));
                }
            }
            this._schedulePushPoll(stream, event, initialNextPoll);
        }

        stream.heartbeatTimer = setInterval(() => {
            if (stream.closed) return;
            void ctx.mcpReq.notify({
                method: 'notifications/events/heartbeat',
                params: { cursor: stream.sub.cursor, _meta: { [SUBSCRIPTION_ID_META_KEY]: requestId } }
            });
        }, this._pushOptions.heartbeatIntervalMs);
        if (typeof stream.heartbeatTimer === 'object' && 'unref' in stream.heartbeatTimer) {
            (stream.heartbeatTimer as unknown as { unref: () => void }).unref();
        }
    }

    private _schedulePushPoll(stream: PushStream, event: InternalRegisteredEvent, initialNextPollMs?: number): void {
        let currentInterval = initialNextPollMs ?? DEFAULT_POLL_MS;
        const tick = async () => {
            if (stream.closed) return;
            const result = await this._runCheckTick(
                event,
                stream.sub.eventName,
                stream.sub.params,
                stream.sub.internalCheckCursor,
                stream.sub.ctx
            );
            if ('error' in result) {
                this._sendErrorNotification(stream, result.error);
                stream.pollTimer = setTimeout(tick, currentInterval);
                return;
            }
            if (result.truncated) {
                stream.sub.internalCheckCursor = null;
                this._sendActiveNotification(stream, stream.sub.cursor, true);
            } else {
                stream.sub.internalCheckCursor = result.nextInternalCheckCursor;
            }
            for (const occ of result.events) {
                if (!(await this._safeMatches(event, stream.sub.params, occ.data, stream.sub.id))) continue;
                this._deliverToPush(stream, await this._safeTransform(event, stream.sub.params, occ, stream.sub.id));
            }
            if (result.nextPollMs !== undefined) currentInterval = result.nextPollMs;
            stream.pollTimer = setTimeout(tick, result.hasMore ? 0 : currentInterval);
        };
        stream.pollTimer = setTimeout(tick, currentInterval);
    }

    private _closeStream(stream: PushStream): void {
        if (stream.closed) return;
        stream.closed = true;
        if (stream.pollTimer) clearTimeout(stream.pollTimer);
        if (stream.heartbeatTimer) clearInterval(stream.heartbeatTimer);
        const event = this._events.get(stream.sub.eventName);
        if (event?.hooks?.onUnsubscribe) {
            void Promise.resolve(event.hooks.onUnsubscribe(stream.sub.id, stream.sub.params, stream.sub.ctx)).catch(() => {});
        }
        this._pushStreams.delete(stream);
        stream.resolve();
    }

    private async _handleSubscribe(params: SubscribeEventRequestParams, ctx: ServerContext): Promise<SubscribeEventResult> {
        const ttl = this._webhookOptions!.ttlMs!;

        const event = this._events.get(params.name);
        if (!event || !event.enabled) {
            throw new ProtocolError(EVENT_NOT_FOUND, `Unknown event: ${params.name}`);
        }

        const paramsResult = await this._validateParams(event, params.arguments);
        if ('error' in paramsResult) {
            throw new ProtocolError(paramsResult.error.code, paramsResult.error.message, paramsResult.error.data);
        }

        const urlCheck = isSafeWebhookUrl(params.delivery.url, this._webhookOptions?.urlValidation);
        if (!urlCheck.safe) {
            throw new ProtocolError(INVALID_CALLBACK_URL, urlCheck.reason ?? 'Callback URL rejected');
        }

        try {
            decodeWebhookSecret(params.delivery.secret);
        } catch (error) {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, (error as Error).message);
        }

        const { key, id } = await this._subscriptionKey(ctx, params.delivery.url, params.name, paramsResult.params);
        const existing = this._webhookSubs.get(key);
        const isNew = !existing;
        if (isNew && this._webhookSubs.size >= this._maxWebhookSubs) {
            throw new ProtocolError(TOO_MANY_SUBSCRIPTIONS, `Webhook subscription limit (${this._maxWebhookSubs}) reached`);
        }

        if (isNew && event.hooks?.onSubscribe) {
            await event.hooks.onSubscribe(id, paramsResult.params, ctx);
        }

        // Cursor semantics: on a fresh sub, null = start from now. On refresh,
        // null = keep the server's current position; non-null = replace.
        let cursor: string | null;
        let backlog: EventOccurrence[] = [];
        let truncated = false;
        if (existing && (params.cursor ?? null) === null) {
            cursor = existing.cursor;
        } else {
            const replay = await this._replayAfterCursor(event, paramsResult.params, params.cursor ?? null, params.maxAgeMs, id);
            backlog = replay.events;
            truncated = replay.truncated;
            cursor = backlog.at(-1)?.cursor ?? (truncated ? replay.headCursor : (params.cursor ?? null));
        }

        const expiresAt = Date.now() + ttl;
        const headSeq = event.log.nextSeq - 1;
        const sub: WebhookSubscription = existing ?? {
            id,
            key,
            eventName: params.name,
            params: paramsResult.params,
            cursor,
            internalCheckCursor: null,
            ctx,
            url: params.delivery.url,
            secrets: [params.delivery.secret],
            acknowledgedSeq: headSeq,
            expiresAt,
            deliveryStatus: { active: true, lastDeliveryAt: null, lastError: null }
        };

        sub.cursor = cursor;
        // Secret rotation: if the supplied secret differs, retain previous
        // for dual-signing until the next refresh.
        if (params.delivery.secret !== sub.secrets[0]) {
            sub.secrets = [params.delivery.secret, sub.secrets[0]!];
        }
        sub.expiresAt = expiresAt;
        sub.ctx = ctx;
        const priorStatus = sub.deliveryStatus;
        sub.deliveryStatus = { ...sub.deliveryStatus, active: true, failedSince: null };

        if (isNew) {
            this._webhookSubs.set(key, sub);
        }

        // Initial check tick.
        let nextPollMs: number | undefined;
        const tick = await this._runCheckTick(event, params.name, paramsResult.params, sub.internalCheckCursor, ctx);
        if ('error' in tick) {
            // Surfaced via deliveryStatus on the next refresh; don't fail subscribe.
        } else {
            sub.internalCheckCursor = tick.nextInternalCheckCursor;
            nextPollMs = tick.nextPollMs;
            truncated ||= tick.truncated;
            for (const occ of tick.events) {
                if (!(await this._safeMatches(event, sub.params, occ.data, sub.id))) continue;
                void this._deliverWebhook(sub, await this._safeTransform(event, sub.params, occ, sub.id));
            }
        }

        if (isNew && this._pushOptions.pollDriven) {
            this._scheduleWebhookPoll(sub, event, nextPollMs);
        }

        for (const occ of backlog) void this._deliverWebhook(sub, occ);

        return {
            id,
            refreshBefore: new Date(expiresAt).toISOString(),
            cursor: sub.cursor,
            truncated,
            deliveryStatus: isNew ? undefined : priorStatus
        };
    }

    private async _handleUnsubscribe(params: UnsubscribeEventRequestParams, ctx: ServerContext): Promise<Record<string, never>> {
        const event = this._events.get(params.name);
        if (!event) {
            throw new ProtocolError(EVENT_NOT_FOUND, `Unknown event: ${params.name}`);
        }
        const paramsResult = await this._validateParams(event, params.arguments);
        if ('error' in paramsResult) {
            throw new ProtocolError(paramsResult.error.code, paramsResult.error.message, paramsResult.error.data);
        }
        const { key } = await this._subscriptionKey(ctx, params.delivery.url, params.name, paramsResult.params);
        const sub = this._webhookSubs.get(key);
        if (!sub) {
            throw new ProtocolError(SUBSCRIPTION_NOT_FOUND, `No subscription matches the supplied key`);
        }
        await this._teardownWebhookSub(sub, ctx);
        this._webhookSubs.delete(key);
        return {};
    }

    private _scheduleWebhookPoll(sub: WebhookSubscription, event: InternalRegisteredEvent, initialNextPollMs?: number): void {
        let currentInterval = initialNextPollMs ?? DEFAULT_POLL_MS;
        const tick = async () => {
            if (!this._webhookSubs.has(sub.key)) return;
            if (!sub.deliveryStatus.active) {
                sub.pollTimer = setTimeout(tick, currentInterval);
                return;
            }
            const result = await this._runCheckTick(event, sub.eventName, sub.params, sub.internalCheckCursor, sub.ctx);
            if ('error' in result) {
                sub.pollTimer = setTimeout(tick, currentInterval);
                return;
            }
            if (result.truncated) {
                sub.internalCheckCursor = null;
                void this._deliverWebhookControl(sub, { type: 'gap', cursor: sub.cursor });
            } else {
                sub.internalCheckCursor = result.nextInternalCheckCursor;
            }
            for (const occ of result.events) {
                if (!(await this._safeMatches(event, sub.params, occ.data, sub.id))) continue;
                void this._deliverWebhook(sub, await this._safeTransform(event, sub.params, occ, sub.id));
            }
            if (result.nextPollMs !== undefined) currentInterval = result.nextPollMs;
            sub.pollTimer = setTimeout(tick, result.hasMore ? 0 : currentInterval);
        };
        sub.pollTimer = setTimeout(tick, currentInterval);
    }

    /**
     * Validates the callback URL's resolved address(es) against private/loopback
     * ranges at delivery time (DNS-rebinding mitigation).
     */
    private async _resolveDeliveryTarget(rawUrl: string): Promise<{ url: string; host: string }> {
        const parsed = new URL(rawUrl);
        const host = parsed.host;
        if (!this._webhookOptions?.urlValidation?.allowPrivateNetworks) {
            const addresses = await this._resolveHost(parsed.hostname);
            for (const { address } of addresses) {
                if (isPrivateAddress(normaliseHostname(address))) {
                    throw Object.assign(new Error(`Callback host resolved to private/loopback address`), {
                        category: 'connection_refused' as WebhookLastError
                    });
                }
            }
            if (parsed.protocol === 'http:' && addresses[0]) {
                const addr = addresses[0].address;
                parsed.hostname = addresses[0].family === 6 ? `[${addr}]` : addr;
            }
        }
        return { url: parsed.toString(), host };
    }

    private _classifyDeliveryError(error: unknown): WebhookLastError {
        if (error && typeof error === 'object' && 'category' in error) {
            return (error as { category: WebhookLastError }).category;
        }
        const msg = error instanceof Error ? error.message : String(error);
        if (/abort|timeout/i.test(msg)) return 'timeout';
        if (/tls|certificate|ssl/i.test(msg)) return 'tls_error';
        if (/redirect/i.test(msg)) return 'connection_refused';
        return 'connection_refused';
    }

    private async _postWebhook(sub: WebhookSubscription, msgId: string, body: string, occurrenceSeq?: number): Promise<void> {
        if (new TextEncoder().encode(body).length > WEBHOOK_MAX_BODY_BYTES) {
            console.error(`[events] webhook body for ${sub.id} exceeds ${WEBHOOK_MAX_BODY_BYTES} bytes; dropping`);
            sub.deliveryStatus = {
                ...sub.deliveryStatus,
                active: sub.deliveryStatus.active,
                lastError: 'http_4xx',
                failedSince: sub.deliveryStatus.failedSince ?? new Date().toISOString()
            };
            return;
        }

        const maxAttempts = this._webhookOptions?.maxDeliveryAttempts ?? 3;
        let delay = this._webhookOptions?.initialRetryDelayMs ?? 1000;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const { url, host } = await this._resolveDeliveryTarget(sub.url);
                const timestamp = Math.floor(Date.now() / 1000);
                const sigs = await Promise.all(sub.secrets.map(s => computeWebhookSignature(s, msgId, timestamp, body)));
                const res = await this._fetch(url, {
                    method: 'POST',
                    redirect: 'error',
                    headers: {
                        'Content-Type': 'application/json',
                        Host: host,
                        [WEBHOOK_ID_HEADER]: msgId,
                        [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
                        [WEBHOOK_SIGNATURE_HEADER]: sigs.join(' '),
                        [WEBHOOK_SUBSCRIPTION_ID_HEADER]: sub.id
                    },
                    body
                });
                if (res.ok) {
                    sub.deliveryStatus = { active: true, lastDeliveryAt: new Date().toISOString(), lastError: null, failedSince: null };
                    if (occurrenceSeq !== undefined && occurrenceSeq > sub.acknowledgedSeq) {
                        sub.acknowledgedSeq = occurrenceSeq;
                        const event = this._events.get(sub.eventName);
                        const acked = event?.log.entries.find(e => e.seq === occurrenceSeq);
                        if (acked) sub.cursor = acked.cursor;
                    }
                    return;
                }
                const category: WebhookLastError = res.status >= 500 ? 'http_5xx' : 'http_4xx';
                if (res.status === 413 || (res.status >= 400 && res.status < 500)) {
                    // Non-retryable client errors.
                    sub.deliveryStatus = {
                        active: false,
                        lastDeliveryAt: sub.deliveryStatus.lastDeliveryAt ?? null,
                        lastError: category,
                        failedSince: sub.deliveryStatus.failedSince ?? new Date().toISOString()
                    };
                    return;
                }
                throw Object.assign(new Error('http_5xx'), { category });
            } catch (error) {
                if (attempt >= maxAttempts) {
                    sub.deliveryStatus = {
                        active: false,
                        lastDeliveryAt: sub.deliveryStatus.lastDeliveryAt ?? null,
                        lastError: this._classifyDeliveryError(error),
                        failedSince: sub.deliveryStatus.failedSince ?? new Date().toISOString()
                    };
                    return;
                }
                await new Promise(r => setTimeout(r, delay));
                delay *= 2;
            }
        }
    }

    private _deliverWebhook(sub: WebhookSubscription, occurrence: EventOccurrence | null): Promise<void> {
        if (occurrence === null) return Promise.resolve();
        const event = this._events.get(sub.eventName);
        const seq = occurrence.cursor ? event?.log.cursorMap.get(occurrence.cursor) : undefined;
        return this._postWebhook(sub, occurrence.eventId, JSON.stringify(occurrence), seq);
    }

    /**
     * POSTs a signed control envelope (`{type: 'gap'|'terminated'|'verification', ...}`)
     * to the callback URL. `webhook-id` is `msg_<type>_<random>` so receivers can
     * dedup retries.
     */
    private _deliverWebhookControl(sub: WebhookSubscription, envelope: WebhookControlEnvelope): Promise<void> {
        const msgId = `msg_${envelope.type}_${(this._eventCounter++).toString(36)}`;
        return this._postWebhook(sub, msgId, JSON.stringify(envelope));
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

    private _sendActiveNotification(stream: PushStream, cursor: string | null, truncated: boolean): void {
        if (stream.closed) return;
        void stream.sub.ctx.mcpReq.notify({
            method: 'notifications/events/active',
            params: { cursor, truncated, _meta: { [SUBSCRIPTION_ID_META_KEY]: stream.requestId } }
        });
    }

    private _sendErrorNotification(stream: PushStream, error: EventSubscriptionError): void {
        if (stream.closed) return;
        void stream.sub.ctx.mcpReq.notify({
            method: 'notifications/events/error',
            params: { error, _meta: { [SUBSCRIPTION_ID_META_KEY]: stream.requestId } }
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
        cursor: string | null,
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
            // Swallow — caller is on a cleanup/error path already.
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
