import type { DeliveryMode, DeliveryStatus, EventOccurrence } from '@modelcontextprotocol/core/ext/events';
import { HEADER_MISMATCH_ERROR_CODE, ProtocolError } from '@modelcontextprotocol/core-internal';
import { EventsError } from '@modelcontextprotocol/core-internal/ext/events';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal/public';

import { NoCompatibleDeliveryModeError } from './errors';
import type { EventsConnection } from './request';

// setTimeout fires at once beyond this.
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
 * error is handled by its kind:
 *
 * - `notFound`, or `unsupported` for a schema change: the event types are
 *   listed again, and delivery goes on while the event type is still listed
 *   with this delivery mode; otherwise the loop ends with that `EventsError`.
 *   After a schema change delivery resumes from the last cursor; when the
 *   server refuses that cursor too, it starts again from now and `onGap`
 *   reports it.
 * - Any other `EventsError` (`forbidden`, `invalidParams`, `resourceExhausted`,
 *   `callbackEndpointError`, any other `unsupported`): the loop ends with it,
 *   and `kind` says why.
 * - A `ProtocolError` `-32020` (the `Mcp-Param` headers do not match the
 *   arguments): the event types are listed again and the request is retried
 *   once with fresh headers; a second `-32020` ends the loop with it.
 * - Anything else (a network or transport failure, another JSON-RPC error, a
 *   push stream that ends or goes silent): retried after a backoff.
 *
 * Closing the client, or connecting it again, ends its subscriptions: the loop
 * rejects with an `SdkError` (`ConnectionClosed`) at once when a request is in
 * flight, otherwise when the next one would be sent; after reconnecting,
 * subscribe again and pass {@linkcode EventSubscription.cursor}.
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

// An error of the first exchange that subscribe() rejects with (a -32020 only once its re-list is spent); any other (transport, non-Events JSON-RPC) is retried in the background.
export function refusesSubscription(error: unknown): boolean {
    return error instanceof EventsError || error instanceof SdkError || isHeaderMismatch(error);
}

// A -32020: the request's `Mcp-Param` headers do not match its arguments (D26).
export function isHeaderMismatch(error: unknown): boolean {
    return error instanceof ProtocolError && error.code === HEADER_MISMATCH_ERROR_CODE;
}

// What a subscription ends with when its client's connection closes.
export function closedError(cause?: unknown): SdkError {
    return new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed', undefined, cause === undefined ? undefined : { cause });
}

// The SdkError a subscription ends with when its client's connection is gone, judged at a failed request; `undefined` while connected.
export function connectionClosed(connection: EventsConnection, error: unknown): SdkError | undefined {
    if (error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed) return error;
    const notConnected = error instanceof SdkError && error.code === SdkErrorCode.NotConnected;
    if (!notConnected && connection.client.transport !== undefined) return undefined;
    return closedError(error);
}

// An `unsupported` error saying the event type's schema changed in place.
export function isSchemaChange(error: unknown): boolean {
    return (
        error instanceof EventsError &&
        error.kind === 'unsupported' &&
        (error.data as { reason?: unknown } | undefined)?.reason === 'schema_changed'
    );
}

// Every mode's recovery once subscribed (spec §6.3): `relist` and go on while still offered, `mismatch` (re-list and retry once, then end), `fail` (end with the error), or `retry` later.
export function recoveryFor(error: unknown): 'relist' | 'mismatch' | 'fail' | 'retry' {
    if (isHeaderMismatch(error)) return 'mismatch';
    if (!(error instanceof EventsError)) return 'retry';
    return error.kind === 'notFound' || isSchemaChange(error) ? 'relist' : 'fail';
}

// Reports a possible gap at `cursor` through onGap; a throwing onGap goes to the client's onerror, and delivery goes on.
export function reportGap(subscription: SubscribeOptions, connection: EventsConnection, cursor: string | null): void {
    try {
        subscription.onGap?.(cursor);
    } catch (error) {
        connection.report(error);
    }
}

// Re-lists, then throws why `name` cannot be subscribed with `mode`: notFound when unlisted, NoCompatibleDeliveryModeError when `mode` is not offered.
export async function requireOffered(connection: EventsConnection, name: string, mode: DeliveryMode, signal: AbortSignal): Promise<void> {
    try {
        await connection.list(undefined, { signal });
    } catch (error) {
        throw connectionClosed(connection, error) ?? error;
    }
    const descriptor = connection.descriptor(name);
    if (descriptor === undefined) throw new EventsError('notFound', 'Event type not found', { kind: 'event' });
    if (!descriptor.delivery.includes(mode)) throw new NoCompatibleDeliveryModeError(name, descriptor.delivery, [mode]);
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
