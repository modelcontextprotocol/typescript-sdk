import type {
    EventDeliveryMode,
    EventDescriptor,
    EventNotification,
    EventOccurrence,
    EventSubscriptionError,
    RequestOptions
} from '@modelcontextprotocol/core';
import { CURSOR_EXPIRED, ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/core';

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
     * Optional shared secret to override server generation. If omitted, the
     * server mints a secret and returns it in the subscribe response (see
     * {@linkcode onSecret}). Supply this only when the secret is provisioned
     * out-of-band.
     */
    secret?: string;
    /**
     * Called whenever the server returns a (new) signing secret — on initial
     * subscribe, and on any refresh where the server has (re)created the
     * subscription (restart, TTL expiry). The receiver MUST verify deliveries
     * with this secret. The current secret is also exposed as
     * {@linkcode EventSubscription.secret}.
     */
    onSecret?: (secret: string, subscriptionId: string) => void | Promise<void>;
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
     * Resume from a known cursor. If set, the initial `events/subscribe` /
     * `events/stream` / `events/poll` request carries this cursor so the server
     * can replay buffered events from that point. Without it, delivery starts
     * from the current head ("now").
     */
    cursor?: string;
}

/**
 * Retry behaviour for transport-level failures (network errors, transient
 * server errors) in the poll, push and webhook delivery loops.
 *
 * Exponential backoff: attempt N waits `min(baseDelayMs * 2^(N-1), maxDelayMs)`.
 * The attempt counter resets to 0 on the first successful round-trip.
 */
export interface RetryOptions {
    /** Maximum consecutive failures before the subscription is failed. Default 5. */
    maxAttempts?: number;
    /** First retry delay in ms. Default 1000. */
    baseDelayMs?: number;
    /** Ceiling on retry delay in ms. Default 30000. */
    maxDelayMs?: number;
}

/**
 * Options for {@linkcode ClientEventManager}.
 */
export interface ClientEventManagerOptions {
    /**
     * Webhook configuration. If set, the SDK will prefer webhook delivery
     * where the server supports it.
     */
    webhook?: WebhookConfig;
    /**
     * Default poll interval (seconds) if the server doesn't provide one.
     * Defaults to 30.
     */
    defaultPollIntervalSeconds?: number;
    /**
     * Low-level request options applied to all protocol calls (`events/poll`,
     * `events/stream`, `events/subscribe`).
     */
    requestOptions?: RequestOptions;
    /**
     * Retry behaviour for transport-level failures across all delivery loops.
     * See {@linkcode RetryOptions}.
     */
    retry?: RetryOptions;
}

const DEFAULT_POLL_SECONDS = 30;
const DEFAULT_DEDUPE_WINDOW = 256;
const DEFAULT_RETRY: Required<RetryOptions> = { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 30_000 };

/**
 * Internal queue state backing a single {@linkcode EventSubscription}'s async
 * iterator.
 */
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
     * The client-generated subscription ID (sent to the server as the `id` field).
     */
    readonly id: string;
    /**
     * The event type name this subscription is for.
     */
    readonly name: string;
    /**
     * Subscription parameters passed to the server.
     */
    readonly params: Record<string, unknown>;
    /**
     * The delivery mode actually in use (may differ from what was requested if
     * the server doesn't support the requested mode).
     */
    readonly delivery: EventDeliveryMode;
    /**
     * Current cursor position. Updated after each delivered batch.
     */
    cursor: string | null = null;
    /**
     * Current webhook signing secret (webhook delivery only). Set from the
     * server's subscribe response; updated whenever the server (re)mints one.
     */
    secret: string | null = null;

    /** @internal */
    constructor(
        id: string,
        name: string,
        params: Record<string, unknown>,
        delivery: EventDeliveryMode,
        private readonly _dedupeWindow: number,
        private readonly _onCancel: () => Promise<void>
    ) {
        this.id = id;
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
        this.cursor = occurrence.cursor;
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
        // Reject (not resolve done:true) so a `for await` body sees the error
        // immediately as a thrown exception, instead of exiting cleanly and
        // never observing it.
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

    /**
     * Cancels this subscription. Stops the poll loop, closes the push stream
     * connection (or re-opens it without this subscription if others remain),
     * or calls `events/unsubscribe` (webhook mode).
     *
     * The async iterator completes cleanly after this call.
     */
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

/**
 * High-level client-side event subscription manager. Handles delivery mode
 * selection, poll loops, push stream lifecycle, webhook refresh cycles, cursor
 * tracking, deduplication, and cursor-expiry recovery.
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
    private _subscriptions = new Map<string, EventSubscription>();

    // Poll-mode state: one shared loop drives all poll-mode subscriptions.
    private _pollSubs = new Map<string, EventSubscription>();
    private _pollTimer?: ReturnType<typeof setTimeout>;
    private _pollInFlight = false;

    // Push-mode state: one shared `events/stream` request carries all push subs.
    private _pushSubs = new Map<string, EventSubscription>();
    private _pushController?: AbortController;
    private _pushHandlersInstalled = false;
    private _pushRestartTimer?: ReturnType<typeof setTimeout>;

    // Webhook-mode state: per-subscription refresh timers.
    private _webhookTimers = new Map<string, ReturnType<typeof setTimeout>>();

    // Per-loop transport-error attempt counters, reset on success.
    private _pollAttempts = 0;
    private _pushAttempts = 0;
    private readonly _retry: Required<RetryOptions>;

    constructor(
        private readonly _client: Client,
        private readonly _options: ClientEventManagerOptions = {}
    ) {
        this._retry = { ...DEFAULT_RETRY, ..._options.retry };
    }

    private _backoffDelay(attempt: number): number {
        return Math.min(this._retry.baseDelayMs * 2 ** (attempt - 1), this._retry.maxDelayMs);
    }

    /**
     * Lists event types the server offers, caching the result. Subsequent calls
     * return the cached list unless `force` is `true` or a
     * `notifications/events/list_changed` has been received.
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
     *
     * For **poll** and **push** modes, the subscription is activated
     * asynchronously (the first poll tick / stream bootstrap happens on the next
     * event-loop turn). If you need to know the subscription is fully active
     * before producing upstream events (e.g. in tests), await
     * `sub.cursor !== null`.
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

        const id = crypto.randomUUID();
        const dedupe = options.dedupeWindow ?? DEFAULT_DEDUPE_WINDOW;

        const sub = new EventSubscription(id, name, params, mode, dedupe, async () => {
            this._subscriptions.delete(id);
            await this._teardown(sub);
        });
        if (options.cursor !== undefined) sub.cursor = options.cursor;

        options.signal?.addEventListener('abort', () => void sub.cancel(), { once: true });

        this._subscriptions.set(id, sub);
        await this._activate(sub, descriptor);
        return sub;
    }

    /**
     * Cancels all active subscriptions and releases resources.
     */
    async close(): Promise<void> {
        const subs = [...this._subscriptions.values()];
        await Promise.all(subs.map(s => s.cancel()));
        if (this._pollTimer) clearTimeout(this._pollTimer);
        if (this._pushRestartTimer) clearTimeout(this._pushRestartTimer);
        this._pushController?.abort();
        for (const timer of this._webhookTimers.values()) clearTimeout(timer);
        this._webhookTimers.clear();
    }

    /**
     * Delivers a webhook POST body to the matching subscription. The caller is
     * responsible for HMAC verification via `verifyWebhookSignature()`.
     *
     * The body shape is `{ id, eventId, name, timestamp, data, cursor }`.
     */
    deliverWebhookPayload(payload: EventNotification['params']): void {
        const sub = this._subscriptions.get(payload.id);
        if (!sub || sub.delivery !== 'webhook') return;
        const { id: _id, ...occurrence } = payload;
        void _id;
        sub._push(occurrence);
    }

    private _selectMode(descriptor: EventDescriptor): EventDeliveryMode {
        if (this._options.webhook && descriptor.delivery.includes('webhook')) return 'webhook';
        if (descriptor.delivery.includes('push')) return 'push';
        return 'poll';
    }

    private async _activate(sub: EventSubscription, descriptor: EventDescriptor): Promise<void> {
        switch (sub.delivery) {
            case 'poll': {
                this._pollSubs.set(sub.id, sub);
                this._schedulePoll(0);
                break;
            }
            case 'push': {
                this._pushSubs.set(sub.id, sub);
                this._restartPushStream();
                break;
            }
            case 'webhook': {
                await this._activateWebhook(sub, descriptor);
                break;
            }
        }
    }

    private async _teardown(sub: EventSubscription): Promise<void> {
        switch (sub.delivery) {
            case 'poll': {
                this._pollSubs.delete(sub.id);
                if (this._pollSubs.size === 0 && this._pollTimer) {
                    clearTimeout(this._pollTimer);
                    this._pollTimer = undefined;
                }
                break;
            }
            case 'push': {
                this._pushSubs.delete(sub.id);
                this._restartPushStream();
                break;
            }
            case 'webhook': {
                const timer = this._webhookTimers.get(sub.id);
                if (timer) clearTimeout(timer);
                this._webhookTimers.delete(sub.id);
                try {
                    await this._client.unsubscribeEvent(
                        { id: sub.id, delivery: { url: this._options.webhook!.url } },
                        this._options.requestOptions
                    );
                } catch {
                    // Best-effort cleanup — TTL will reclaim it.
                }
                break;
            }
        }
    }

    // ------- Poll mode -------

    private _schedulePoll(delayMs: number): void {
        if (this._pollTimer) clearTimeout(this._pollTimer);
        if (this._pollSubs.size === 0) return;
        this._pollTimer = setTimeout(() => void this._runPoll(), delayMs);
    }

    private async _runPoll(): Promise<void> {
        if (this._pollInFlight || this._pollSubs.size === 0) return;
        this._pollInFlight = true;
        const subs = [...this._pollSubs.values()];
        const subscriptions = subs.map(s => ({ id: s.id, name: s.name, params: s.params, cursor: s.cursor }));
        try {
            const { results } = await this._client.pollEvents({ subscriptions }, this._options.requestOptions);
            let minNextMs = (this._options.defaultPollIntervalSeconds ?? DEFAULT_POLL_SECONDS) * 1000;
            let anyHasMore = false;
            for (const entry of results) {
                const sub = this._pollSubs.get(entry.id);
                if (!sub) continue;
                if (entry.error) {
                    this._handleSubError(sub, entry.error);
                    continue;
                }
                for (const event of entry.events ?? []) sub._push(event);
                if (entry.cursor) sub.cursor = entry.cursor;
                if (entry.hasMore) anyHasMore = true;
                if (entry.nextPollSeconds !== undefined) {
                    minNextMs = Math.min(minNextMs, entry.nextPollSeconds * 1000);
                }
            }
            this._pollAttempts = 0;
            this._schedulePoll(anyHasMore ? 0 : minNextMs);
        } catch (error) {
            this._pollAttempts++;
            if (this._pollAttempts >= this._retry.maxAttempts) {
                for (const sub of subs) sub._fail(error instanceof Error ? error : new Error(String(error)));
                this._pollAttempts = 0;
            } else {
                this._schedulePoll(this._backoffDelay(this._pollAttempts));
            }
        } finally {
            this._pollInFlight = false;
        }
    }

    // ------- Push mode -------

    private _restartPushStream(delayMs = 0): void {
        // Debounce restarts so rapid subscribe/unsubscribe batches coalesce.
        if (this._pushRestartTimer) clearTimeout(this._pushRestartTimer);
        this._pushRestartTimer = setTimeout(() => {
            this._pushRestartTimer = undefined;
            void this._openPushStream();
        }, delayMs);
    }

    private _installPushHandlers(): void {
        if (this._pushHandlersInstalled) return;
        this._client.setNotificationHandler('notifications/events/event', n => {
            const sub = this._pushSubs.get(n.params.id);
            if (!sub) return;
            const { id: _id, ...occurrence } = n.params;
            void _id;
            sub._push(occurrence);
        });
        this._client.setNotificationHandler('notifications/events/active', n => {
            const sub = this._pushSubs.get(n.params.id);
            if (sub) sub.cursor = n.params.cursor;
        });
        this._client.setNotificationHandler('notifications/events/error', n => {
            const sub = this._pushSubs.get(n.params.id);
            if (sub) this._handleSubError(sub, n.params.error);
        });
        this._client.setNotificationHandler('notifications/events/terminated', n => {
            const sub = this._pushSubs.get(n.params.id);
            if (sub) {
                sub._fail(new ProtocolError(n.params.error.code, n.params.error.message, n.params.error.data));
                this._pushSubs.delete(sub.id);
            }
        });
        // Heartbeat is a no-op — its absence over the transport's idle timeout
        // is what signals connection death.
        this._client.setNotificationHandler('notifications/events/heartbeat', () => {});
        this._pushHandlersInstalled = true;
    }

    private async _openPushStream(): Promise<void> {
        // Close any existing stream — cursor-based replay covers the gap.
        this._pushController?.abort();
        this._pushController = undefined;

        if (this._pushSubs.size === 0) return;

        this._installPushHandlers();

        const controller = new AbortController();
        this._pushController = controller;
        const subscriptions = [...this._pushSubs.values()].map(s => ({
            id: s.id,
            name: s.name,
            params: s.params,
            cursor: s.cursor
        }));

        // events/stream is long-lived — it never resolves until the controller aborts.
        // 0x7fffffff is the max 32-bit signed int that setTimeout accepts (~24.8 days);
        // larger values overflow to 1ms on Node. The server's heartbeat keeps the
        // transport alive underneath.
        void this._client
            .request(
                { method: 'events/stream', params: { subscriptions } },
                {
                    ...this._options.requestOptions,
                    signal: controller.signal,
                    timeout: 0x7f_ff_ff_ff
                }
            )
            .then(() => {
                this._pushAttempts = 0;
            })
            .catch(error => {
                if (controller.signal.aborted) return;
                this._pushAttempts++;
                if (this._pushAttempts >= this._retry.maxAttempts) {
                    for (const sub of this._pushSubs.values()) {
                        sub._fail(error instanceof Error ? error : new Error(String(error)));
                    }
                    this._pushSubs.clear();
                    this._pushAttempts = 0;
                    return;
                }
                // Connection dropped unexpectedly — reconnect with cursors after backoff.
                this._restartPushStream(this._backoffDelay(this._pushAttempts));
            });
    }

    // ------- Webhook mode -------

    private async _activateWebhook(sub: EventSubscription, _descriptor: EventDescriptor): Promise<void> {
        const webhook = this._options.webhook;
        if (!webhook) {
            throw new SdkError(
                SdkErrorCode.CapabilityNotSupported,
                'Webhook delivery requested but no WebhookConfig is set on the ClientEventManager'
            );
        }

        let attempts = 0;
        const refresh = async (isInitial: boolean) => {
            try {
                const result = await this._client.subscribeEvent(
                    {
                        id: sub.id,
                        name: sub.name,
                        params: sub.params,
                        delivery: {
                            mode: 'webhook',
                            url: webhook.url,
                            ...(webhook.secret === undefined ? {} : { secret: webhook.secret })
                        },
                        cursor: sub.cursor
                    },
                    this._options.requestOptions
                );
                if (result.secret !== undefined) {
                    sub.secret = result.secret;
                    await webhook.onSecret?.(result.secret, sub.id);
                }

                // Surface delivery problems but don't kill the subscription —
                // the refresh reactivates the server's delivery loop.
                if (result.deliveryStatus && !result.deliveryStatus.active) {
                    console.warn(`[events] webhook delivery paused for ${sub.id}: ${result.deliveryStatus.lastError}`);
                }

                attempts = 0;
                // The subscription may have been cancelled while we were
                // awaiting subscribeEvent above; clearTimeout in _teardown
                // doesn't stop an in-flight call. Don't reschedule if so —
                // otherwise the timer revives a cancelled subscription forever.
                if (!this._subscriptions.has(sub.id)) return;
                const ttlMs = new Date(result.refreshBefore).getTime() - Date.now();
                const fraction = webhook.refreshFraction ?? 0.5;
                // Floor prevents a tight spin if refreshBefore is somehow in the past;
                // 50ms is small enough to handle sub-second TTLs while still rate-limiting.
                const nextMs = Math.max(50, ttlMs * fraction);
                this._webhookTimers.set(
                    sub.id,
                    setTimeout(() => void refresh(false), nextMs)
                );
            } catch (error) {
                // Initial subscribe failure surfaces directly to subscribe()'s
                // caller. Background refresh failures retry with backoff so a
                // transient blip doesn't kill an otherwise-healthy subscription.
                if (isInitial) {
                    sub._fail(error instanceof Error ? error : new Error(String(error)));
                    return;
                }
                if (!this._subscriptions.has(sub.id)) return;
                attempts++;
                if (attempts >= this._retry.maxAttempts) {
                    sub._fail(error instanceof Error ? error : new Error(String(error)));
                    return;
                }
                this._webhookTimers.set(
                    sub.id,
                    setTimeout(() => void refresh(false), this._backoffDelay(attempts))
                );
            }
        };

        await refresh(true);
    }

    // ------- Shared -------

    private _handleSubError(sub: EventSubscription, error: EventSubscriptionError): void {
        if (error.code === CURSOR_EXPIRED) {
            // Recoverable: reset cursor and let the next tick/poll re-bootstrap.
            sub.cursor = null;
            return;
        }
        const protocolError = new ProtocolError(error.code, error.message, error.data);
        sub._fail(protocolError);
        this._subscriptions.delete(sub.id);
        this._pollSubs.delete(sub.id);
        this._pushSubs.delete(sub.id);
    }
}
