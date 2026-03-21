import type {
    AnySchema,
    EventDeliveryMode,
    EventDescriptor,
    EventOccurrence,
    EventPollHints,
    EventSubscriptionError,
    EventSubscriptionSpec,
    FetchLike,
    ListEventsResult,
    PollEventsResult,
    PollEventsResultEntry,
    SchemaOutput,
    ServerContext,
    SubscribeEventResult,
    WebhookDeliveryStatus,
    WebhookUrlValidationOptions
} from '@modelcontextprotocol/core';
import {
    computeWebhookSignature,
    CURSOR_EXPIRED,
    EVENT_NOT_FOUND,
    INVALID_CALLBACK_URL,
    isSafeWebhookUrl,
    parseSchemaAsync,
    ProtocolError,
    ProtocolErrorCode,
    schemaToJson,
    SUBSCRIPTION_NOT_FOUND,
    TOO_MANY_SUBSCRIPTIONS,
    WEBHOOK_SIGNATURE_HEADER,
    WEBHOOK_TIMESTAMP_HEADER
} from '@modelcontextprotocol/core';

import type { Server } from './server.js';

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
     * Polling-interval hints for the client SDK.
     */
    pollHints?: EventPollHints;
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
    pollHints?: EventPollHints;
    inputSchema?: AnySchema;
    payloadSchema?: AnySchema;
    enabled: boolean;
    enable(): void;
    disable(): void;
    update(updates: { description?: string; pollHints?: EventPollHints; enabled?: boolean }): void;
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

interface InternalRegisteredEvent {
    title?: string;
    description?: string;
    pollHints?: EventPollHints;
    inputSchema?: AnySchema;
    payloadSchema?: AnySchema;
    hooks?: EventSubscriptionHooks;
    matches?: EventMatchCallback;
    _meta?: Record<string, unknown>;
    check: EventCheckCallback;
    enabled: boolean;
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
            pollHints: config.pollHints,
            inputSchema: config.inputSchema,
            payloadSchema: config.payloadSchema,
            hooks: config.hooks as EventSubscriptionHooks | undefined,
            matches: config.matches as EventMatchCallback | undefined,
            _meta: config._meta,
            check: check as EventCheckCallback,
            enabled: true
        };
        this._events.set(name, entry);

        this._initializeHandlers();
        this._sendEventListChanged();

        const registered: RegisteredEvent = {
            description: entry.description,
            pollHints: entry.pollHints,
            inputSchema: entry.inputSchema,
            payloadSchema: entry.payloadSchema,
            enabled: true,
            enable: () => registered.update({ enabled: true }),
            disable: () => registered.update({ enabled: false }),
            update: updates => {
                if (updates.description !== undefined) entry.description = updates.description;
                if (updates.pollHints !== undefined) entry.pollHints = updates.pollHints;
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

        const deliverTo = (sub: ActiveSubscription, sink: 'push' | 'webhook', stream?: PushStream) => {
            if (options.subscriptionId && sub.id !== options.subscriptionId) return;
            if (!options.subscriptionId && event.matches && !event.matches(sub.params, data)) return;

            sub.cursor = occurrence.eventId;
            const withCursor: EventOccurrence = { ...occurrence, cursor: sub.cursor };
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
        const webhook = this._webhookSubs.get(subscriptionId);
        if (webhook) {
            void this._teardownWebhookSub(webhook);
            this._webhookSubs.delete(subscriptionId);
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
                pollHints: event.pollHints,
                inputSchema: event.inputSchema
                    ? (schemaToJson(event.inputSchema, { io: 'input' }) as EventDescriptor['inputSchema'])
                    : EMPTY_OBJECT_JSON_SCHEMA,
                payloadSchema: event.payloadSchema
                    ? (schemaToJson(event.payloadSchema, { io: 'output' }) as EventDescriptor['payloadSchema'])
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

    private async _pollOne(spec: EventSubscriptionSpec, maxEvents: number, ctx: ServerContext): Promise<PollEventsResultEntry> {
        const event = this._events.get(spec.name);
        if (!event || !event.enabled) {
            return { id: spec.id, error: { code: EVENT_NOT_FOUND, message: `Unknown event: ${spec.name}` } };
        }

        const paramsResult = await this._validateParams(event, spec.params);
        if ('error' in paramsResult) {
            return { id: spec.id, error: paramsResult.error };
        }

        // Lifecycle: null cursor = bootstrap = onSubscribe hook.
        if ((spec.cursor ?? null) === null && event.hooks?.onSubscribe) {
            await event.hooks.onSubscribe(spec.id, paramsResult.params, ctx);
        }

        let checkResult: EventCheckResult;
        try {
            checkResult = await event.check(paramsResult.params, spec.cursor ?? null, ctx);
        } catch (error) {
            return { id: spec.id, error: this._toSubscriptionError(error) };
        }

        const occurrences = checkResult.events.slice(0, maxEvents).map(e => this._makeOccurrence(e.name ?? spec.name, e.data, e._meta));
        const hasMore = checkResult.hasMore ?? checkResult.events.length > maxEvents;
        const nextPollSeconds = checkResult.nextPollSeconds ?? event.pollHints?.intervalSeconds.recommended ?? DEFAULT_POLL_SECONDS;

        return {
            id: spec.id,
            events: occurrences,
            cursor: checkResult.cursor,
            hasMore,
            nextPollSeconds
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

            let bootCursor: string;
            try {
                const bootstrap = await event.check(paramsResult.params, spec.cursor ?? null, stream.ctx);
                bootCursor = bootstrap.cursor;
                // If reconnecting with a cursor, replay any backlog from bootstrap.
                for (const e of bootstrap.events) {
                    const occ = this._makeOccurrence(e.name ?? spec.name, e.data, e._meta);
                    occ.cursor = bootstrap.cursor;
                    this._sendEventNotification(stream, spec.id, occ);
                }
            } catch (error) {
                this._sendErrorNotification(stream, spec.id, this._toSubscriptionError(error));
                continue;
            }

            if ((spec.cursor ?? null) === null && event.hooks?.onSubscribe) {
                await event.hooks.onSubscribe(spec.id, paramsResult.params, stream.ctx);
            }

            const active: ActiveSubscription = {
                id: spec.id,
                eventName: spec.name,
                params: paramsResult.params,
                cursor: bootCursor,
                ctx: stream.ctx
            };
            stream.subscriptions.set(spec.id, active);
            this._sendActiveNotification(stream, spec.id, bootCursor);

            if (this._pushOptions.pollDriven) {
                this._schedulePushPoll(stream, active, event);
            }
        }

        // Heartbeat.
        stream.heartbeatTimer = setInterval(() => {
            if (stream.closed) return;
            void stream.ctx.mcpReq.notify({ method: 'notifications/events/heartbeat' });
        }, this._pushOptions.heartbeatIntervalMs);
        if (typeof stream.heartbeatTimer === 'object' && 'unref' in stream.heartbeatTimer) {
            (stream.heartbeatTimer as unknown as { unref: () => void }).unref();
        }
    }

    private _schedulePushPoll(stream: PushStream, sub: ActiveSubscription, event: InternalRegisteredEvent): void {
        const interval = (event.pollHints?.intervalSeconds.recommended ?? DEFAULT_POLL_SECONDS) * 1000;
        const tick = async () => {
            if (stream.closed) return;
            try {
                const result = await event.check(sub.params, sub.cursor, stream.ctx);
                for (const e of result.events) {
                    const occ = this._makeOccurrence(e.name ?? sub.eventName, e.data, e._meta);
                    sub.cursor = result.cursor;
                    occ.cursor = sub.cursor;
                    this._sendEventNotification(stream, sub.id, occ);
                }
                sub.cursor = result.cursor;
                const nextMs = result.hasMore ? 0 : (result.nextPollSeconds ?? interval / 1000) * 1000;
                stream.pollTimers.set(sub.id, setTimeout(tick, nextMs));
            } catch (error) {
                const subErr = this._toSubscriptionError(error);
                this._sendErrorNotification(stream, sub.id, subErr);
                // CursorExpired is recoverable by re-bootstrapping; anything else terminates the subscription.
                if (subErr.code === CURSOR_EXPIRED) {
                    const reboot = await event.check(sub.params, null, stream.ctx);
                    sub.cursor = reboot.cursor;
                    stream.pollTimers.set(sub.id, setTimeout(tick, interval));
                } else {
                    stream.subscriptions.delete(sub.id);
                }
            }
        };
        stream.pollTimers.set(sub.id, setTimeout(tick, interval));
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
            delivery: { mode: 'webhook'; url: string; secret: string };
            cursor?: string | null;
        },
        ctx: ServerContext
    ): Promise<SubscribeEventResult> {
        const ttl = this._webhookOptions!.ttlMs!;
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

        const existing = this._webhookSubs.get(params.id);
        const isNew = !existing;
        if (isNew && this._webhookSubs.size >= this._maxWebhookSubs) {
            throw new ProtocolError(TOO_MANY_SUBSCRIPTIONS, `Webhook subscription limit (${this._maxWebhookSubs}) reached`);
        }

        // Bootstrap/resume cursor.
        const inCursor = params.cursor ?? existing?.cursor ?? null;
        let cursor: string;
        let backlog: EventCheckResult['events'] = [];
        try {
            const bootstrap = await event.check(paramsResult.params, inCursor, ctx);
            cursor = bootstrap.cursor;
            backlog = bootstrap.events;
        } catch (error) {
            const subErr = this._toSubscriptionError(error);
            throw new ProtocolError(subErr.code, subErr.message, subErr.data);
        }

        const expiresAt = Date.now() + ttl;
        const sub: WebhookSubscription = existing ?? {
            id: params.id,
            eventName: params.name,
            params: paramsResult.params,
            cursor,
            ctx,
            url: params.delivery.url,
            secret: params.delivery.secret,
            expiresAt,
            deliveryStatus: { active: true, lastDeliveryAt: null, lastError: null }
        };

        // Upsert fields.
        sub.eventName = params.name;
        sub.params = paramsResult.params;
        sub.cursor = cursor;
        sub.url = params.delivery.url;
        sub.secret = params.delivery.secret;
        sub.expiresAt = expiresAt;
        sub.ctx = ctx;
        // A successful refresh reactivates a subscription that had been backed off.
        sub.deliveryStatus = { ...sub.deliveryStatus, active: true, lastError: null, failedSince: null };

        if (isNew) {
            this._webhookSubs.set(params.id, sub);
            if (event.hooks?.onSubscribe) {
                await event.hooks.onSubscribe(params.id, paramsResult.params, ctx);
            }
            if (this._pushOptions.pollDriven) {
                this._scheduleWebhookPoll(sub, event);
            }
        }

        // Deliver any backlog from the bootstrap/resume check.
        for (const e of backlog) {
            const occ = this._makeOccurrence(e.name ?? params.name, e.data, e._meta);
            occ.cursor = cursor;
            void this._deliverWebhook(sub, occ);
        }

        return {
            id: params.id,
            cursor,
            refreshBefore: new Date(expiresAt).toISOString(),
            deliveryStatus: isNew ? undefined : sub.deliveryStatus
        };
    }

    private async _handleUnsubscribe(params: { id: string }, ctx: ServerContext): Promise<Record<string, never>> {
        const sub = this._webhookSubs.get(params.id);
        if (!sub) {
            throw new ProtocolError(SUBSCRIPTION_NOT_FOUND, `Unknown subscription: ${params.id}`);
        }
        await this._teardownWebhookSub(sub, ctx);
        this._webhookSubs.delete(params.id);
        return {};
    }

    private _scheduleWebhookPoll(sub: WebhookSubscription, event: InternalRegisteredEvent): void {
        const interval = (event.pollHints?.intervalSeconds.recommended ?? DEFAULT_POLL_SECONDS) * 1000;
        const tick = async () => {
            if (!this._webhookSubs.has(sub.id)) return;
            if (!sub.deliveryStatus.active) {
                sub.pollTimer = setTimeout(tick, interval);
                return;
            }
            try {
                const result = await event.check(sub.params, sub.cursor, sub.ctx);
                for (const e of result.events) {
                    const occ = this._makeOccurrence(e.name ?? sub.eventName, e.data, e._meta);
                    sub.cursor = result.cursor;
                    occ.cursor = sub.cursor;
                    void this._deliverWebhook(sub, occ);
                }
                sub.cursor = result.cursor;
                const nextMs = result.hasMore ? 0 : (result.nextPollSeconds ?? interval / 1000) * 1000;
                sub.pollTimer = setTimeout(tick, nextMs);
            } catch (error) {
                const subErr = this._toSubscriptionError(error);
                if (subErr.code === CURSOR_EXPIRED) {
                    const reboot = await event.check(sub.params, null, sub.ctx);
                    sub.cursor = reboot.cursor;
                }
                sub.pollTimer = setTimeout(tick, interval);
            }
        };
        sub.pollTimer = setTimeout(tick, interval);
    }

    private async _deliverWebhook(sub: WebhookSubscription, occurrence: EventOccurrence): Promise<void> {
        const body = JSON.stringify({ id: sub.id, ...occurrence });
        const maxAttempts = this._webhookOptions?.maxDeliveryAttempts ?? 3;
        let delay = this._webhookOptions?.initialRetryDelayMs ?? 1000;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const timestamp = Math.floor(Date.now() / 1000);
                const signature = await computeWebhookSignature(sub.secret, timestamp, body);
                const res = await this._fetch(sub.url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
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

    private async _teardownWebhookSub(sub: WebhookSubscription, ctx?: ServerContext): Promise<void> {
        if (sub.pollTimer) clearTimeout(sub.pollTimer);
        const event = this._events.get(sub.eventName);
        if (event?.hooks?.onUnsubscribe) {
            await Promise.resolve(event.hooks.onUnsubscribe(sub.id, sub.params, ctx ?? sub.ctx)).catch(() => {});
        }
    }

    private _reapExpiredWebhooks(): void {
        const now = Date.now();
        for (const [id, sub] of this._webhookSubs) {
            if (sub.expiresAt <= now) {
                void this._teardownWebhookSub(sub);
                this._webhookSubs.delete(id);
            }
        }
    }

    private _sendEventNotification(stream: PushStream, id: string, occurrence: EventOccurrence): void {
        if (stream.closed) return;
        void stream.ctx.mcpReq.notify({
            method: 'notifications/event',
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
        const parsed = await parseSchemaAsync(event.inputSchema, params ?? {});
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
