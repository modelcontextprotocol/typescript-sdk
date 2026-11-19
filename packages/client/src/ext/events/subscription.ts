import type { DeliveryMode, DeliveryStatus, EventOccurrence } from '@modelcontextprotocol/core/ext/events';

import type { EventsConnection } from './request';

/**
 * What to subscribe to, and how.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export interface SubscribeOptions {
    /** The event type, as `events/list` names it. */
    name: string;
    /** Subscription arguments, valid against the event type's `inputSchema`. */
    arguments?: Record<string, unknown>;
    /** Forces one delivery mode instead of the default preference (webhook, then push, then poll). */
    delivery?: DeliveryMode;
    /** Resumes from a persisted {@linkcode EventSubscription.cursor}; `null` or absent starts from now. */
    cursor?: string | null;
    /** Replays no event older than this many milliseconds, however old `cursor` is. */
    maxAgeMs?: number;
    /**
     * Called with the fresh cursor when events may have been skipped: the
     * server reports `truncated`, or delivery started again from now after a
     * schema change. An error it throws goes to the client's `onerror`, and
     * delivery goes on.
     */
    onGap?: (cursor: string | null) => void;
}

/**
 * One subscription's events. The `for await` loop, and how a subscription
 * recovers from errors, are the same in every delivery mode. A refusal of the
 * subscription itself comes from `subscribe()`. Once subscribed, a server
 * error (an error response, a push `terminated` frame or a webhook
 * `terminated` body) is handled by its kind:
 *
 * - `notFound`, or `unsupported` for a schema change: the event types are
 *   listed again, and delivery goes on while the event type is still listed
 *   with this delivery mode; otherwise the loop ends with that `EventsError`.
 *   After a schema change delivery resumes from the last cursor; when the
 *   server refuses that cursor too, it starts again from now and `onGap`
 *   reports it.
 * - Any other `EventsError` (`forbidden`, `invalidParams`, `resourceExhausted`
 *   other than the webhook verification limit, `callbackEndpointError`, any
 *   other `unsupported`): the loop ends with it, and `kind` says why.
 * - A `ProtocolError` `-32020` (the `Mcp-Param` headers do not match the
 *   arguments): the event types are listed again and the request is retried
 *   once with fresh headers; a second `-32020` ends the loop with it.
 * - Anything else (a network or transport failure, another JSON-RPC error, a
 *   push stream that ends, goes silent or sends no valid `active`): retried
 *   after a backoff. The server's webhook verification limit
 *   (`resourceExhausted` with `data.limit: 'verification'`) is retried after
 *   its `data.retryAfterMs`, or after a backoff without one.
 *
 * Closing the client, or connecting it again without resuming its session,
 * ends its subscriptions at once: the loop rejects with an `SdkError`
 * (`ConnectionClosed`), and a webhook subscription is left to lapse on the
 * server. After reconnecting, subscribe again and pass
 * {@linkcode EventSubscription.cursor}.
 * `T` types `data` and is not checked against the event type's
 * `payloadSchema`. Leaving the loop early cancels the subscription.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export interface EventSubscription<T = Record<string, unknown>> extends AsyncIterable<EventOccurrence & { data: T }> {
    /**
     * The newest cursor that is safe to persist: it covers every event the
     * loop has finished with (an event is finished when the loop asks for the
     * next one). `null` for event types that do not support replay.
     */
    readonly cursor: string | null;
    readonly deliveryMode: DeliveryMode;
    /** Webhook delivery health, as the server last reported it in an `events/subscribe` result. */
    readonly deliveryStatus?: DeliveryStatus;
    /**
     * Stops delivery and ends the loop. Cancelling the last of identical
     * webhook subscriptions also removes the subscription on the server
     * (`events/unsubscribe`).
     */
    cancel(): Promise<void>;
}

// Runs one subscription's delivery mode into its queue.
export interface Driver {
    // Settles after the mode's first exchange: rejects with a refusesSubscription() error, leaving nothing running; otherwise resolves and keeps delivering.
    start(): Promise<void>;
    // Resolves once nothing more arrives.
    stop(): Promise<void>;
}

// What a driver delivers into: one subscription's queue, or (webhook) one that passes everything on to identical subscriptions.
export type DeliveryQueue<T> = Pick<SubscriptionQueue<T>, 'push' | 'setCursor' | 'setDeliveryStatus' | 'fail'>;

// What a driver runs: the subscription, the queue its events go into, and the connection it requests through.
export interface DriverContext<T> {
    readonly subscription: SubscribeOptions;
    readonly queue: DeliveryQueue<T>;
    readonly connection: EventsConnection;
}

export type Item<T> = EventOccurrence & { data: T };

// In delivery order: an event, or a cursor that becomes current once the loop has moved past the events before it.
type Entry<T> = { event: Item<T> } | { cursor: string | null };

const DEDUPE_WINDOW = 1000;

// The `EventSubscription` a driver delivers into.
export class SubscriptionQueue<T> implements EventSubscription<T> {
    readonly deliveryMode: DeliveryMode;
    #cursor: string | null;
    #deliveryStatus: DeliveryStatus | undefined;
    readonly #entries: Entry<T>[] = [];
    readonly #seen = new Set<string>();
    readonly #waiters: Array<{ resolve(result: IteratorResult<Item<T>>): void; reject(error: unknown): void }> = [];
    // The loop holds an event it has not finished with.
    #holding = false;
    // Set by fail() or end(); delivered after the queued events.
    #finish: { error: unknown } | 'end' | undefined;
    #closed = false;
    #driver: Driver | undefined;
    #cancelled: Promise<void> | undefined;

    constructor(deliveryMode: DeliveryMode, cursor: string | null) {
        this.deliveryMode = deliveryMode;
        this.#cursor = cursor;
    }

    get cursor(): string | null {
        return this.#cursor;
    }

    get deliveryStatus(): DeliveryStatus | undefined {
        return this.#deliveryStatus;
    }

    // Starts `driver`, which cancel() stops; settles as its first exchange does.
    run(driver: Driver): Promise<void> {
        this.#driver = driver;
        return driver.start();
    }

    // Queues an event unless its eventId is among the last 1 000 queued.
    push(event: EventOccurrence): void {
        if (this.#done() || this.#seen.has(event.eventId)) return;
        this.#seen.add(event.eventId);
        if (this.#seen.size > DEDUPE_WINDOW) this.#seen.delete(this.#seen.values().next().value!);
        const item = event as Item<T>;
        const waiter = this.#waiters.shift();
        if (waiter === undefined) {
            this.#entries.push({ event: item });
            return;
        }
        this.#holding = true;
        waiter.resolve({ done: false, value: item });
    }

    setCursor(cursor: string | null): void {
        if (this.#done()) return;
        if (this.#entries.length === 0 && !this.#holding) this.#cursor = cursor;
        else this.#entries.push({ cursor });
    }

    setDeliveryStatus(status: DeliveryStatus): void {
        this.#deliveryStatus = status;
    }

    // Ends the loop with `error` once the queued events are delivered.
    fail(error: unknown): void {
        if (this.#done()) return;
        this.#finish = { error };
        this.#settleWaiters();
    }

    // Ends the loop once the queued events are delivered.
    end(): void {
        if (this.#done()) return;
        this.#finish = 'end';
        this.#settleWaiters();
    }

    cancel(): Promise<void> {
        this.#cancelled ??= (async () => {
            this.#closed = true;
            this.#entries.length = 0;
            for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
            await this.#driver?.stop();
        })();
        return this.#cancelled;
    }

    [Symbol.asyncIterator](): AsyncIterator<Item<T>> {
        return {
            next: () => this.#next(),
            return: async () => {
                await this.cancel();
                return { done: true, value: undefined };
            }
        };
    }

    #done(): boolean {
        return this.#closed || this.#finish !== undefined;
    }

    #next(): Promise<IteratorResult<Item<T>>> {
        this.#holding = false;
        let entry = this.#entries.shift();
        while (entry !== undefined && 'cursor' in entry) {
            this.#cursor = entry.cursor;
            entry = this.#entries.shift();
        }
        if (entry !== undefined) {
            this.#holding = true;
            return Promise.resolve({ done: false, value: entry.event });
        }
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        if (this.#finish !== undefined) return this.#deliverFinish();
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
    }

    // Waiters exist only while nothing is queued, so the finish reaches them at once.
    #settleWaiters(): void {
        const waiter = this.#waiters.shift();
        if (waiter === undefined) return;
        this.#deliverFinish().then(waiter.resolve, waiter.reject);
        for (const rest of this.#waiters.splice(0)) rest.resolve({ done: true, value: undefined });
    }

    #deliverFinish(): Promise<IteratorResult<Item<T>>> {
        const finish = this.#finish;
        this.#closed = true;
        return finish === 'end' || finish === undefined ? Promise.resolve({ done: true, value: undefined }) : Promise.reject(finish.error);
    }
}
