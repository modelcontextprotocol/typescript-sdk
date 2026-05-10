import type {
    EventDeliveryMode,
    EventDescriptor,
    EventOccurrence,
    EventSubscriptionError,
    RequestId,
    RequestOptions,
    WebhookControlEnvelope
} from '@modelcontextprotocol/core';
import {
    decodeWebhookSecret,
    generateWebhookSecret,
    ProtocolError,
    SdkError,
    SdkErrorCode,
    SUBSCRIPTION_ID_META_KEY
} from '@modelcontextprotocol/core';

import type { Client } from './client.js';

/**
 * Webhook configuration for the client event manager. When set, the SDK will
 * prefer webhook delivery where the server supports it.
 */
export interface WebhookConfig {
    /**
     * Callback URL the server will POST events to.
     */
    url: string;
    /**
     * HMAC signing secret (Standard Webhooks `whsec_` format). The SDK
     * generates one from a CSPRNG if omitted; supply this only when the secret
     * is provisioned out-of-band (e.g. registered with a gateway). The same
     * secret is sent on every subscribe call.
     */
    secret?: string;
    /**
     * Fraction of the server-announced `refreshBefore` interval at which to
     * re-subscribe. `0.5` (the default) means refresh halfway through the TTL.
     */
    refreshFraction?: number;
}

/**
 * Options for {@linkcode ClientEventManager.subscribe}.
 */
export interface SubscribeOptions {
    /**
     * Force a specific delivery mode. If omitted, the SDK picks the best
     * available: webhook > push > poll.
     */
    delivery?: EventDeliveryMode;
    /**
     * Number of most-recently-seen `eventId`s to keep for deduplication.
     * Defaults to 256.
     */
    dedupeWindow?: number;
    /**
     * AbortSignal for cancelling the subscription. Equivalent to calling
     * {@linkcode EventSubscription.cancel}.
     */
    signal?: AbortSignal;
    /**
     * Resume from a known cursor.
     */
    cursor?: string;
    /**
     * Do not replay events older than this many milliseconds.
     */
    maxAgeMs?: number;
    /**
     * Cap the number of events the server returns per poll batch. Ignored for
     * push and webhook delivery.
     */
    maxEvents?: number;
}

/**
 * Retry behaviour for transport-level failures across all delivery loops.
 * Exponential backoff: attempt N waits `min(baseDelayMs * 2^(N-1), maxDelayMs)`.
 */
export interface RetryOptions {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
}

/**
 * Options for {@linkcode ClientEventManager}.
 */
export interface ClientEventManagerOptions {
    webhook?: WebhookConfig;
    defaultPollIntervalMs?: number;
    requestOptions?: RequestOptions;
    retry?: RetryOptions;
}

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_DEDUPE_WINDOW = 256;
const DEFAULT_RETRY: Required<RetryOptions> = { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 30_000 };

interface SubscriptionQueue {
    buffer: EventOccurrence[];
    waiters: { resolve: (v: IteratorResult<EventOccurrence>) => void; reject: (e: Error) => void }[];
    done: boolean;
    error?: Error;
}

/**
 * A single subscription to an event type. Implements `AsyncIterable`
 * so you can `for await (const event of sub) { ... }`.
 *
 * Created by {@linkcode ClientEventManager.subscribe}.
 */
export class EventSubscription implements AsyncIterable<EventOccurrence> {
    private _queue: SubscriptionQueue = { buffer: [], waiters: [], done: false };
    private _seen: string[] = [];

    /**
     * Routing handle. For webhook delivery this is the server-derived `id`
     * returned by `events/subscribe` (deterministic over `(principal, url, name,
     * params)`). For poll/push it is a local handle assigned by the SDK.
     */
    id: string;
    readonly name: string;
    readonly params: Record<string, unknown>;
    readonly delivery: EventDeliveryMode;
    /** Current cursor. `null` means non-replayable or "start from now". */
    cursor: string | null = null;
    /**
     * `true` if at any point the server signalled events were skipped (the
     * cursor fell outside retention, `maxAgeMs` floor advanced past it, or the
     * server applied a ceiling). Consumers SHOULD treat this as a possible gap
     * and re-fetch authoritative state via tools if it matters.
     */
    truncated = false;
    /** Webhook signing secret (webhook delivery only). */
    secret: string | null = null;

    /** @internal */
    constructor(
        name: string,
        params: Record<string, unknown>,
        delivery: EventDeliveryMode,
        private readonly _dedupeWindow: number,
        private readonly _onCancel: () => Promise<void>
    ) {
        this.id = crypto.randomUUID();
        this.name = name;
        this.params = params;
        this.delivery = delivery;
    }

    /** @internal */
    _push(occurrence: EventOccurrence): void {
        if (this._queue.done) return;
        if (this._seen.includes(occurrence.eventId)) return;
        this._seen.push(occurrence.eventId);
        if (this._seen.length > this._dedupeWindow) this._seen.shift();
        if (occurrence.cursor !== undefined && occurrence.cursor !== null) this.cursor = occurrence.cursor;
        const waiter = this._queue.waiters.shift();
        if (waiter) {
            waiter.resolve({ value: occurrence, done: false });
        } else {
            this._queue.buffer.push(occurrence);
        }
    }

    /** @internal */
    _fail(error: Error): void {
        if (this._queue.done) return;
        this._queue.done = true;
        this._queue.error = error;
        for (const waiter of this._queue.waiters) waiter.reject(error);
        this._queue.waiters = [];
    }

    /** @internal */
    _close(): void {
        if (this._queue.done) return;
        this._queue.done = true;
        for (const waiter of this._queue.waiters) waiter.resolve({ value: undefined as never, done: true });
        this._queue.waiters = [];
    }

    async cancel(): Promise<void> {
        this._close();
        await this._onCancel();
    }

    [Symbol.asyncIterator](): AsyncIterator<EventOccurrence> {
        const queue = this._queue;
        return {
            next: (): Promise<IteratorResult<EventOccurrence>> => {
                if (queue.buffer.length > 0) {
                    return Promise.resolve({ value: queue.buffer.shift()!, done: false });
                }
                if (queue.done) {
                    if (queue.error) return Promise.reject(queue.error);
                    return Promise.resolve({ value: undefined as never, done: true });
                }
                return new Promise((resolve, reject) => queue.waiters.push({ resolve, reject }));
            },
            return: async (): Promise<IteratorResult<EventOccurrence>> => {
                await this.cancel();
                return { value: undefined as never, done: true };
            }
        };
    }
}

interface SubState {
    sub: EventSubscription;
    /** The parent stream's JSON-RPC id; matched against incoming `_meta[subscriptionId]`. */
    requestId?: RequestId;
    pollTimer?: ReturnType<typeof setTimeout>;
    pushController?: AbortController;
    refreshTimer?: ReturnType<typeof setTimeout>;
    attempts: number;
    maxAgeMs?: number;
    maxEvents?: number;
}

/**
 * High-level client-side event subscription manager. Handles delivery mode
 * selection, poll loops, push stream lifecycle, webhook refresh cycles, cursor
 * tracking, deduplication, and gap (`truncated`) handling.
 *
 * @example
 * ```ts source="./events.examples.ts#ClientEventManager_basicUsage"
 * const events = new ClientEventManager(client);
 * const sub = await events.subscribe('email.received', { from: '*@example.com' });
 * for await (const event of sub) {
 *     console.log('New email:', event.data);
 *     if (shouldStop) break;
 * }
 * // Leaving the loop auto-cancels via AsyncIterator.return().
 * ```
 */
export class ClientEventManager {
    private _eventTypes = new Map<string, EventDescriptor>();
    private _eventTypesLoaded = false;
    /** Keyed by the local handle (`sub.id`). */
    private _states = new Map<string, SubState>();
    /** Webhook subs additionally indexed by server-derived id for delivery routing. */
    private _byServerId = new Map<string, SubState>();
    private _pushHandlersInstalled = false;
    private readonly _retry: Required<RetryOptions>;
    private readonly _webhookSecret?: string;

    constructor(
        private readonly _client: Client,
        private readonly _options: ClientEventManagerOptions = {}
    ) {
        this._retry = { ...DEFAULT_RETRY, ..._options.retry };
        if (_options.webhook) {
            const secret = _options.webhook.secret ?? generateWebhookSecret();
            decodeWebhookSecret(secret);
            this._webhookSecret = secret;
        }
    }

    private _backoffDelay(attempt: number): number {
        return Math.min(this._retry.baseDelayMs * 2 ** (attempt - 1), this._retry.maxDelayMs);
    }

    /**
     * Lists event types the server offers, caching the result.
     */
    async listEvents(force = false): Promise<EventDescriptor[]> {
        if (!this._eventTypesLoaded || force) {
            const result = await this._client.listEvents(undefined, this._options.requestOptions);
            this._eventTypes.clear();
            for (const event of result.events) this._eventTypes.set(event.name, event);
            this._eventTypesLoaded = true;
        }
        return [...this._eventTypes.values()];
    }

    /**
     * Subscribes to an event type. Returns an {@linkcode EventSubscription} that
     * is also an `AsyncIterable` yielding `EventOccurrence`s as they arrive.
     */
    async subscribe(name: string, params: Record<string, unknown> = {}, options: SubscribeOptions = {}): Promise<EventSubscription> {
        await this.listEvents();
        const descriptor = this._eventTypes.get(name);
        if (!descriptor) {
            throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not offer event type '${name}'`);
        }

        const mode = options.delivery ?? this._selectMode(descriptor);
        if (!descriptor.delivery.includes(mode)) {
            throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Event '${name}' does not support delivery mode '${mode}'`);
        }

        const dedupe = options.dedupeWindow ?? DEFAULT_DEDUPE_WINDOW;
        const sub: EventSubscription = new EventSubscription(name, params, mode, dedupe, async () => this._teardown(sub));
        if (options.cursor !== undefined) sub.cursor = options.cursor;
        options.signal?.addEventListener('abort', () => void sub.cancel(), { once: true });

        const state: SubState = { sub, attempts: 0, maxAgeMs: options.maxAgeMs, maxEvents: options.maxEvents };
        this._states.set(sub.id, state);
        await this._activate(state);
        return sub;
    }

    /** Cancels all active subscriptions and releases resources. */
    async close(): Promise<void> {
        await Promise.all([...this._states.values()].map(s => s.sub.cancel()));
    }

    /**
     * Delivers a verified webhook POST body to the matching subscription. The
     * caller is responsible for HMAC verification via `verifyWebhookSignature()`
     * before calling this. `subscriptionId` is the value of the
     * `X-MCP-Subscription-Id` header.
     *
     * The body is either a bare `EventOccurrence` (no top-level `type`) or a
     * control envelope (`{type: 'gap'|'terminated'|'verification', ...}`).
     */
    deliverWebhookPayload(subscriptionId: string, body: EventOccurrence | WebhookControlEnvelope): void {
        const state = this._byServerId.get(subscriptionId);
        if (!state || state.sub.delivery !== 'webhook') return;
        if ('type' in body) {
            switch (body.type) {
                case 'gap': {
                    state.sub.truncated = true;
                    if (body.cursor !== null) state.sub.cursor = body.cursor;
                    return;
                }
                case 'terminated': {
                    state.sub._fail(new ProtocolError(body.error.code, body.error.message, body.error.data));
                    void this._teardown(state.sub);
                    return;
                }
                case 'verification': {
                    // Receiver-side challenge response is the gateway's concern.
                    return;
                }
            }
        }
        state.sub._push(body);
    }

    private _selectMode(descriptor: EventDescriptor): EventDeliveryMode {
        if (this._options.webhook && descriptor.delivery.includes('webhook')) return 'webhook';
        if (descriptor.delivery.includes('push')) return 'push';
        return 'poll';
    }

    private async _activate(state: SubState): Promise<void> {
        switch (state.sub.delivery) {
            case 'poll': {
                this._schedulePoll(state, 0);
                break;
            }
            case 'push': {
                this._installPushHandlers();
                this._openPushStream(state);
                break;
            }
            case 'webhook': {
                await this._activateWebhook(state);
                break;
            }
        }
    }

    private async _teardown(sub: EventSubscription): Promise<void> {
        const state = this._states.get(sub.id);
        if (!state) return;
        this._states.delete(sub.id);
        this._byServerId.delete(sub.id);
        if (state.pollTimer) clearTimeout(state.pollTimer);
        if (state.refreshTimer) clearTimeout(state.refreshTimer);
        state.pushController?.abort();
        if (sub.delivery === 'webhook') {
            try {
                await this._client.unsubscribeEvent(
                    { name: sub.name, params: sub.params, delivery: { url: this._options.webhook!.url } },
                    this._options.requestOptions
                );
            } catch {
                // Best-effort — TTL will reclaim it.
            }
        }
    }

    // ------- Poll mode -------

    private _schedulePoll(state: SubState, delayMs: number): void {
        if (state.pollTimer) clearTimeout(state.pollTimer);
        state.pollTimer = setTimeout(() => void this._runPoll(state), delayMs);
    }

    private async _runPoll(state: SubState): Promise<void> {
        if (!this._states.has(state.sub.id)) return;
        const sub = state.sub;
        try {
            const result = await this._client.pollEvents(
                { name: sub.name, params: sub.params, cursor: sub.cursor, maxAgeMs: state.maxAgeMs, maxEvents: state.maxEvents },
                this._options.requestOptions
            );
            for (const event of result.events) sub._push(event);
            if (result.cursor !== null) sub.cursor = result.cursor;
            if (result.truncated) sub.truncated = true;
            state.attempts = 0;
            const nextMs = result.nextPollMs ?? this._options.defaultPollIntervalMs ?? DEFAULT_POLL_MS;
            this._schedulePoll(state, result.hasMore ? 0 : nextMs);
        } catch (error) {
            state.attempts++;
            if (state.attempts >= this._retry.maxAttempts) {
                sub._fail(error instanceof Error ? error : new Error(String(error)));
                this._states.delete(sub.id);
            } else {
                this._schedulePoll(state, this._backoffDelay(state.attempts));
            }
        }
    }

    // ------- Push mode -------

    private _routeByMeta(meta: Record<string, unknown> | undefined): SubState | undefined {
        const requestId = meta?.[SUBSCRIPTION_ID_META_KEY] as RequestId | undefined;
        if (requestId === undefined) return undefined;
        for (const s of this._states.values()) if (s.requestId === requestId) return s;
        return undefined;
    }

    private _installPushHandlers(): void {
        if (this._pushHandlersInstalled) return;
        this._client.setNotificationHandler('notifications/events/event', n => {
            const state = this._routeByMeta(n.params._meta);
            if (!state) return;
            const { _meta, ...occurrence } = n.params;
            void _meta;
            state.sub._push(occurrence);
        });
        this._client.setNotificationHandler('notifications/events/active', n => {
            const state = this._routeByMeta(n.params._meta);
            if (!state) return;
            if (n.params.cursor !== null) state.sub.cursor = n.params.cursor;
            if (n.params.truncated) state.sub.truncated = true;
        });
        this._client.setNotificationHandler('notifications/events/error', n => {
            const state = this._routeByMeta(n.params._meta);
            if (state) this._handleSubError(state.sub, n.params.error);
        });
        this._client.setNotificationHandler('notifications/events/terminated', n => {
            const state = this._routeByMeta(n.params._meta);
            if (state) {
                state.sub._fail(new ProtocolError(n.params.error.code, n.params.error.message, n.params.error.data));
                void this._teardown(state.sub);
            }
        });
        this._client.setNotificationHandler('notifications/events/heartbeat', n => {
            const state = this._routeByMeta(n.params._meta);
            if (state && n.params.cursor !== null) state.sub.cursor = n.params.cursor;
        });
        this._pushHandlersInstalled = true;
    }

    private _openPushStream(state: SubState): void {
        state.pushController?.abort();
        const controller = new AbortController();
        state.pushController = controller;
        const sub = state.sub;

        // events/stream is long-lived; never resolves until cancelled.
        void this._client
            .request(
                {
                    method: 'events/stream',
                    params: { name: sub.name, params: sub.params, cursor: sub.cursor, maxAgeMs: state.maxAgeMs }
                },
                {
                    ...this._options.requestOptions,
                    signal: controller.signal,
                    timeout: 0x7f_ff_ff_ff,
                    onRequestId: id => {
                        state.requestId = id;
                    }
                }
            )
            .then(() => {
                state.attempts = 0;
            })
            .catch(error => {
                if (controller.signal.aborted || !this._states.has(sub.id)) return;
                state.attempts++;
                if (state.attempts >= this._retry.maxAttempts) {
                    sub._fail(error instanceof Error ? error : new Error(String(error)));
                    void this._teardown(sub);
                    return;
                }
                state.pollTimer = setTimeout(() => this._openPushStream(state), this._backoffDelay(state.attempts));
            });
    }

    // ------- Webhook mode -------

    private async _activateWebhook(state: SubState): Promise<void> {
        const webhook = this._options.webhook;
        if (!webhook || !this._webhookSecret) {
            throw new SdkError(
                SdkErrorCode.CapabilityNotSupported,
                'Webhook delivery requested but no WebhookConfig is set on the ClientEventManager'
            );
        }
        const sub = state.sub;
        sub.secret = this._webhookSecret;

        const refresh = async (isInitial: boolean) => {
            try {
                const result = await this._client.subscribeEvent(
                    {
                        name: sub.name,
                        params: sub.params,
                        delivery: { mode: 'webhook', url: webhook.url, secret: this._webhookSecret! },
                        cursor: sub.cursor,
                        maxAgeMs: state.maxAgeMs
                    },
                    this._options.requestOptions
                );
                // Server-derived id is the routing handle (X-MCP-Subscription-Id).
                if (sub.id !== result.id) {
                    this._byServerId.delete(sub.id);
                    sub.id = result.id;
                }
                this._byServerId.set(result.id, state);
                if (result.cursor !== null) sub.cursor = result.cursor;
                if (result.truncated) sub.truncated = true;

                if (result.deliveryStatus && !result.deliveryStatus.active) {
                    console.warn(`[events] webhook delivery paused for ${sub.id}: ${result.deliveryStatus.lastError}`);
                }

                state.attempts = 0;
                if (!this._states.has(sub.id) && !this._byServerId.has(sub.id)) return;
                const ttlMs = new Date(result.refreshBefore).getTime() - Date.now();
                const fraction = webhook.refreshFraction ?? 0.5;
                const nextMs = Math.max(50, ttlMs * fraction);
                state.refreshTimer = setTimeout(() => void refresh(false), nextMs);
            } catch (error) {
                if (isInitial) {
                    sub._fail(error instanceof Error ? error : new Error(String(error)));
                    return;
                }
                if (!this._states.has(sub.id) && !this._byServerId.has(sub.id)) return;
                state.attempts++;
                if (state.attempts >= this._retry.maxAttempts) {
                    sub._fail(error instanceof Error ? error : new Error(String(error)));
                    return;
                }
                state.refreshTimer = setTimeout(() => void refresh(false), this._backoffDelay(state.attempts));
            }
        };

        await refresh(true);
    }

    // ------- Shared -------

    private _handleSubError(sub: EventSubscription, error: EventSubscriptionError): void {
        // notifications/events/error reports a recoverable failure; the
        // subscription remains active and the server retries. Surface to
        // diagnostics but don't kill the subscription.
        console.warn(`[events] recoverable error on ${sub.name}:`, error.message);
    }
}
