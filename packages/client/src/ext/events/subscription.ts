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
    /** Forces one delivery mode instead of the default preference (webhook, then push, then poll) and the fallback from push to poll. */
    delivery?: DeliveryMode;
    /** Resumes from a persisted {@linkcode EventSubscription.cursor}; `null` or absent starts from now. */
    cursor?: string | null;
    /**
     * With `cursor`, delivers no event older than this many milliseconds
     * before `subscribe()` was called, however old `cursor` is, for the life
     * of the subscription: every request it makes, in whatever delivery mode,
     * sends the time since that point. Without `cursor` it is not sent, as the
     * subscription starts from now.
     */
    maxAgeMs?: number;
    /**
     * Called with the cursor delivery continues from when events may have been
     * skipped: the server reports `truncated`, delivery started again from now
     * after a schema change, the loop fell 1 000 events behind on an event type
     * that cannot resume (`null`: delivery paused, or push dropped the oldest
     * queued events), delivery of such a type started again from now (`null`:
     * its push stream was reopened after it ended or went silent, or its
     * webhook subscription was made again after the server stopped holding it,
     * by a `terminated` body the loop carries on from or a grant that ended
     * before the next refresh went out), or a webhook loop 1 000 events behind
     * dropped its oldest queued events while an identical subscription kept up.
     * An error it throws goes to the client's `onerror`, and delivery goes on.
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
 *   A second `notFound` in a row, with no successful exchange between them,
 *   ends the loop even while the event type is listed. After a schema change
 *   delivery resumes from the last cursor; when the server refuses that
 *   cursor too, it starts again from now and `onGap` reports it.
 * - Any other `EventsError` (`forbidden`, `invalidParams`, `resourceExhausted`
 *   other than the webhook verification limit, `callbackEndpointError`, any
 *   other `unsupported`): the loop ends with it, and `kind` says why.
 * - A `ProtocolError` `-32020` (the `Mcp-Param` headers do not match the
 *   arguments): the event types are listed again and the request is retried
 *   once with fresh headers; a second `-32020` ends the loop with it. In a
 *   browser, which sends no `Mcp-Param` headers, the first ends it.
 * - An auth failure of the transport that only the user or the configuration
 *   can fix (an `UnauthorizedError`, such as for a `401` its `authProvider`
 *   could not resolve, an `SdkError` such as a `401` after
 *   re-authentication, an `OAuthError` other than `server_error`,
 *   `temporarily_unavailable` and `too_many_requests`, or an OAuth flow
 *   error such as `InsecureTokenEndpointError`), or a `-32601` (the server no
 *   longer serves the method: a `ProtocolError`, or over Streamable HTTP the
 *   `SdkHttpError` of a `404` whose body is that error): the loop ends with it.
 * - Anything else (a network or transport failure, any other error the
 *   `authProvider` throws, such as a network error or one of those
 *   `OAuthError` codes while it fetches a token, an HTTP error status, another
 *   JSON-RPC error, a push stream that ends before its first valid
 *   `active`, sends none in time, ends after it or goes silent): retried
 *   after a backoff. The server's webhook verification limit
 *   (`resourceExhausted` with `data.limit: 'verification'`) is retried after
 *   its `data.retryAfterMs`, or after a backoff without one. Each of these
 *   failures but a push stream that ends after its `active` or goes silent
 *   is reported to the client's `onerror`: the first at once, then at most
 *   one report a minute with how many were retried since.
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

// What a driver delivers into: one subscription's queue, or (webhook, which never trims) one that passes everything on to identical subscriptions.
export type DeliveryQueue<T> = Pick<SubscriptionQueue<T>, 'push' | 'setCursor' | 'setDeliveryStatus' | 'fail' | 'full'> &
    Partial<Pick<SubscriptionQueue<T>, 'room' | 'trim'>>;

// What a driver runs: the subscription, the queue its events go into, and the connection it requests through.
export interface DriverContext<T> {
    readonly subscription: SubscribeOptions;
    readonly queue: DeliveryQueue<T>;
    readonly connection: EventsConnection;
    // When subscribe() was given a cursor and `maxAgeMs`: that call's time less `maxAgeMs`, before which no event is delivered, kept across a fallback or a mode chosen again.
    readonly floor?: number;
}

export type Item<T> = EventOccurrence & { data: T };

// In delivery order: an event, or a cursor that becomes current once the loop has moved past the events before it.
type Entry<T> = { event: Item<T> } | { cursor: string | null };

const DEDUPE_WINDOW = 1000;
// The most events a subscription holds that its loop has not taken; its driver fetches no more until the loop has taken half of them.
const MAX_QUEUED_EVENTS = 1000;
const RESUME_QUEUED_EVENTS = MAX_QUEUED_EVENTS / 2;

// The `EventSubscription` a driver delivers into.
export class SubscriptionQueue<T> implements EventSubscription<T> {
    readonly deliveryMode: DeliveryMode;
    #cursor: string | null;
    #deliveryStatus: DeliveryStatus | undefined;
    readonly #entries: Entry<T>[] = [];
    readonly #seen = new Set<string>();
    readonly #waiters: Array<{ resolve(result: IteratorResult<Item<T>>): void; reject(error: unknown): void }> = [];
    // The events in #entries, and the wait for them to drain to RESUME_QUEUED_EVENTS: one promise every waiter shares.
    #queued = 0;
    #room: { readonly promise: Promise<void>; readonly resolve: () => void } | undefined;
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

    // MAX_QUEUED_EVENTS events wait for the loop.
    get full(): boolean {
        return this.#queued >= MAX_QUEUED_EVENTS;
    }

    // What the loop has not taken yet: the queued events and the cursors between them.
    get backlog(): number {
        return this.#entries.length;
    }

    // Resolves once the loop has taken the waiting events down to RESUME_QUEUED_EVENTS, or the subscription ends.
    room(): Promise<void> {
        if (this.#queued <= RESUME_QUEUED_EVENTS || this.#done()) return Promise.resolve();
        if (this.#room === undefined) {
            let resolve!: () => void;
            const promise = new Promise<void>(settle => (resolve = settle));
            this.#room = { promise, resolve };
        }
        return this.#room.promise;
    }

    // Starts `driver`, which cancel() stops; settles as its first exchange does.
    run(driver: Driver): Promise<void> {
        this.#driver = driver;
        return driver.start();
    }

    // Queues an event unless its eventId is among the last 1 000 queued; answers whether it took it.
    push(event: EventOccurrence): boolean {
        if (this.#done() || this.#seen.has(event.eventId)) return false;
        this.#seen.add(event.eventId);
        if (this.#seen.size > DEDUPE_WINDOW) this.#seen.delete(this.#seen.values().next().value!);
        const item = event as Item<T>;
        const waiter = this.#waiters.shift();
        if (waiter === undefined) {
            this.#entries.push({ event: item });
            this.#queued += 1;
            return true;
        }
        this.#holding = true;
        waiter.resolve({ done: false, value: item });
        return true;
    }

    // Drops the oldest events the loop has not taken while more than MAX_QUEUED_EVENTS wait; answers whether it dropped any.
    trim(): boolean {
        let dropped = false;
        while (this.#queued > MAX_QUEUED_EVENTS) {
            this.#entries.splice(
                this.#entries.findIndex(entry => 'event' in entry),
                1
            );
            this.#queued -= 1;
            dropped = true;
            // The cursors around a dropped event collapse into the later one, as #next() would apply them.
            while (this.#entries.length > 1 && 'cursor' in this.#entries[0]! && 'cursor' in this.#entries[1]!) this.#entries.shift();
        }
        return dropped;
    }

    setCursor(cursor: string | null): void {
        if (this.#done()) return;
        if (this.#entries.length === 0 && !this.#holding) {
            this.#cursor = cursor;
            return;
        }
        // Cursors in a row apply as the last of them, so one entry stands for every poll, heartbeat or refresh while the loop holds an event.
        const last = this.#entries.length - 1;
        if (last >= 0 && 'cursor' in this.#entries[last]!) this.#entries[last] = { cursor };
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
        this.#releaseRoom();
    }

    // Ends the loop once the queued events are delivered.
    end(): void {
        if (this.#done()) return;
        this.#finish = 'end';
        this.#settleWaiters();
        this.#releaseRoom();
    }

    cancel(): Promise<void> {
        this.#cancelled ??= (async () => {
            this.#closed = true;
            this.#entries.length = 0;
            this.#queued = 0;
            this.#releaseRoom();
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
            this.#queued -= 1;
            if (this.#queued <= RESUME_QUEUED_EVENTS) this.#releaseRoom();
            return Promise.resolve({ done: false, value: entry.event });
        }
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        if (this.#finish !== undefined) return this.#deliverFinish();
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
    }

    #releaseRoom(): void {
        const room = this.#room;
        this.#room = undefined;
        room?.resolve();
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
