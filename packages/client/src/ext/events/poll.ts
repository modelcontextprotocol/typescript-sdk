import type { PollEventsResult } from '@modelcontextprotocol/core/ext/events';
import { EVENTS_POLL_METHOD, PollEventsResultSchema } from '@modelcontextprotocol/core/ext/events';
import { EventsError } from '@modelcontextprotocol/core-internal/ext/events';

import { NoCompatibleDeliveryModeError } from './errors';
import type { Driver, DriverContext } from './subscription';
import { closedError, connectionClosed, isSchemaChange, recoveryFor, refusesSubscription, stillOffered } from './subscription';

const MAX_RETRY_DELAY_MS = 60_000;
// setTimeout fires at once beyond this, which would bypass the floor.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

// Poll delivery (spec §6.3): one `events/poll` loop, again at once on `hasMore`, otherwise after `nextPollMs` but never sooner than the floor.
export class PollDriver<T> implements Driver {
    readonly #context: DriverContext<T>;
    readonly #floorMs: number;
    readonly #abort = new AbortController();
    #cursor: string | null;
    // Sent until a poll succeeds.
    #maxAgeMs: number | undefined;
    #nextPollMs: number | undefined;
    // A schema change has refused a poll since the last successful one.
    #schemaChanged = false;
    // The cursor was reset to now; the next successful poll reports the gap.
    #reset = false;
    // Set by the connection's close listener; ends the loop at once.
    #closed = false;
    #wake: (() => void) | undefined;
    #running: Promise<void> = Promise.resolve();

    constructor(context: DriverContext<T>, floorMs: number) {
        this.#context = context;
        this.#floorMs = floorMs;
        this.#cursor = context.subscription.cursor ?? null;
        this.#maxAgeMs = context.subscription.maxAgeMs;
    }

    start(): Promise<void> {
        let settle!: { resolve(): void; reject(error: unknown): void };
        const first = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
        const removeCloseListener = this.#context.connection.onClose(() => {
            this.#closed = true;
            this.#wake?.();
        });
        this.#running = this.#run(settle.resolve)
            .then(settle.resolve, (error: unknown) => {
                settle.reject(error);
                this.#context.queue.fail(error);
            })
            .finally(removeCloseListener);
        return first;
    }

    async stop(): Promise<void> {
        this.#abort.abort();
        this.#wake?.();
        await this.#running;
    }

    // Calls `subscribed` after the first exchange; throws, ending the subscription, on a first-exchange refusal or a closed connection.
    async #run(subscribed: () => void): Promise<void> {
        const { connection, queue, subscription } = this.#context;
        let first = true;
        let failures = 0;
        while (!this.#abort.signal.aborted) {
            if (this.#closed) throw closedError();
            let result: PollEventsResult;
            try {
                result = await this.#poll();
            } catch (error) {
                if (this.#abort.signal.aborted) return;
                const closed = connectionClosed(connection, error);
                if (closed !== undefined) throw closed;
                if (first && isSchemaChange(error) && this.#cursor !== null) {
                    await this.#restartFromNow();
                    continue;
                }
                if (first && refusesSubscription(error)) throw error;
                first = false;
                subscribed();
                const recovery = recoveryFor(error);
                const gone =
                    recovery === 'fail' ||
                    (recovery === 'relist' && (await stillOffered(connection, subscription.name, 'poll', this.#abort.signal)) === false);
                if (gone) {
                    queue.fail(error);
                    return;
                }
                if (isSchemaChange(error)) this.#schemaChange();
                await this.#sleep(this.#retryDelay(failures++));
                continue;
            }
            failures = 0;
            this.#deliver(result);
            first = false;
            subscribed();
            if (result.hasMore !== true) await this.#sleep(Math.max(result.nextPollMs ?? this.#floorMs, this.#floorMs));
        }
    }

    #poll(): Promise<PollEventsResult> {
        const { name, arguments: args } = this.#context.subscription;
        const mirror = { name, ...(args !== undefined && { arguments: args }) };
        const params = { ...mirror, cursor: this.#cursor, ...(this.#maxAgeMs !== undefined && { maxAgeMs: this.#maxAgeMs }) };
        return this.#context.connection.request(EVENTS_POLL_METHOD, params, PollEventsResultSchema, mirror, { signal: this.#abort.signal });
    }

    // The first poll's cursor was refused for a schema change (a stale one passed to subscribe()): re-list, then poll from now or throw why not.
    async #restartFromNow(): Promise<void> {
        const { connection, subscription } = this.#context;
        try {
            await connection.list(undefined, { signal: this.#abort.signal });
        } catch (error) {
            throw connectionClosed(connection, error) ?? error;
        }
        const descriptor = connection.descriptor(subscription.name);
        if (descriptor === undefined) throw new EventsError('notFound', 'Event type not found', { kind: 'event' });
        if (!descriptor.delivery.includes('poll'))
            throw new NoCompatibleDeliveryModeError(subscription.name, descriptor.delivery, ['poll']);
        this.#cursor = null;
        this.#reset = true;
    }

    // A second schema change in a row means the last cursor is refused (SEP: a stale schema epoch), so start again from now.
    #schemaChange(): void {
        if (this.#schemaChanged && this.#cursor !== null) {
            this.#cursor = null;
            this.#reset = true;
        }
        this.#schemaChanged = true;
    }

    #deliver(result: PollEventsResult): void {
        const { queue, subscription } = this.#context;
        const cursor = result.cursor ?? null;
        const reset = this.#reset;
        this.#maxAgeMs = undefined;
        this.#nextPollMs = result.nextPollMs;
        this.#schemaChanged = false;
        this.#reset = false;
        // A type without replay has no position to have skipped past (SEP: ignore `truncated`).
        if (reset || (result.truncated === true && cursor !== null)) subscription.onGap?.(cursor);
        for (const event of result.events) queue.push(event);
        this.#cursor = cursor;
        queue.setCursor(cursor);
    }

    // max(floor, nextPollMs), doubling per consecutive failure up to 60 s, never below that base.
    #retryDelay(failures: number): number {
        const base = Math.max(this.#floorMs, this.#nextPollMs ?? this.#floorMs);
        return Math.max(base, Math.min(MAX_RETRY_DELAY_MS, base * 2 ** failures));
    }

    #sleep(ms: number): Promise<void> {
        return new Promise(resolve => {
            if (this.#abort.signal.aborted || this.#closed) return resolve();
            const wake = (): void => {
                clearTimeout(timer);
                this.#wake = undefined;
                resolve();
            };
            const timer = setTimeout(wake, Math.min(ms, MAX_TIMER_DELAY_MS));
            this.#wake = wake;
        });
    }
}
