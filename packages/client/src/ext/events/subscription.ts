import type { DeliveryMode, DeliveryStatus, EventOccurrence } from '@modelcontextprotocol/core/ext/events';
import { EventsError } from '@modelcontextprotocol/core-internal/ext/events';
import { SdkError } from '@modelcontextprotocol/core-internal/public';

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
    /** Called with the fresh cursor when the server reports that events were skipped (`truncated`). */
    onGap?: (cursor: string | null) => void;
}

/**
 * One subscription's events. The `for await` loop is the same for every
 * delivery mode. A refusal of the subscription itself comes from
 * `subscribe()`; once subscribed, the loop ends with an `EventsError` when the
 * server ends the subscription (`kind` says why: `forbidden`,
 * `invalidParams`, or `notFound` and a schema change once the event type is no
 * longer listed). Other failures are retried. `T` types `data` and is not
 * checked against the event type's `payloadSchema`. Leaving the loop early
 * cancels the subscription.
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
    /** Webhook delivery health, as the server last reported it. */
    readonly deliveryStatus?: DeliveryStatus;
    /** Stops delivery and ends the loop. */
    cancel(): Promise<void>;
}

// Runs one subscription's delivery mode into its queue.
export interface Driver {
    // Settles after the mode's first exchange: rejects with a refusesSubscription() error, leaving nothing running; otherwise resolves and keeps delivering.
    start(): Promise<void>;
    // Resolves once nothing more arrives.
    stop(): Promise<void>;
}

// What a driver runs: the subscription, the queue its events go into, and the connection it requests through.
export interface DriverContext<T> {
    readonly subscription: SubscribeOptions;
    readonly queue: SubscriptionQueue<T>;
    readonly connection: EventsConnection;
}

// An error of the first exchange that subscribe() rejects with; any other (transport, non-Events JSON-RPC) is retried in the background.
export function refusesSubscription(error: unknown): boolean {
    return error instanceof EventsError || error instanceof SdkError;
}

// After a server error once subscribed (spec §6.3): re-list and go on if the event type is still offered, end the subscription, or retry later.
export function recoveryFor(error: unknown): 'relist' | 'fail' | 'retry' {
    if (!(error instanceof EventsError)) return 'retry';
    const data = error.data as Record<string, unknown> | undefined;
    switch (error.kind) {
        case 'notFound': {
            return 'relist';
        }
        case 'unsupported': {
            return data?.['reason'] === 'schema_changed' ? 'relist' : 'retry';
        }
        case 'forbidden':
        case 'invalidParams': {
            return 'fail';
        }
        default: {
            return 'retry';
        }
    }
}

// Re-lists, then whether `name` is still listed with `mode`; `undefined` when the list fails.
export async function stillOffered(
    connection: EventsConnection,
    name: string,
    mode: DeliveryMode,
    signal: AbortSignal
): Promise<boolean | undefined> {
    try {
        await connection.list(undefined, { signal });
    } catch {
        return undefined;
    }
    return connection.descriptor(name)?.delivery.includes(mode) === true;
}

type Item<T> = EventOccurrence & { data: T };

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
