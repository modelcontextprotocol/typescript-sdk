import type { EventOccurrence, EventsActiveNotificationParams } from '@modelcontextprotocol/core/ext/events';
import {
    EventNotificationParamsSchema,
    EVENTS_ACTIVE_NOTIFICATION,
    EVENTS_EVENT_NOTIFICATION,
    EVENTS_HEARTBEAT_NOTIFICATION,
    EVENTS_STREAM_METHOD,
    EVENTS_TERMINATED_NOTIFICATION,
    EventsActiveNotificationParamsSchema,
    EventsHeartbeatNotificationParamsSchema,
    EventsTerminatedNotificationParamsSchema
} from '@modelcontextprotocol/core/ext/events';
import type { JSONRPCNotification } from '@modelcontextprotocol/core-internal';
import { ProtocolError, SUBSCRIPTION_ID_META_KEY } from '@modelcontextprotocol/core-internal';
import type * as z from 'zod/v4';

import type { StreamEnd, StreamHandle } from '../../client/client';
import { clientInternals } from '../../client/client';
import { asEventsError } from './request';
import type { Driver, DriverContext } from './subscription';
import {
    closedError,
    connectionClosed,
    isSchemaChange,
    MAX_TIMER_DELAY_MS,
    recoveryFor,
    refusesSubscription,
    reportGap,
    requireOffered,
    stillOffered
} from './subscription';

// No message for this many granted heartbeat intervals, counted from `active`, means the stream is dead (SEP-3415 §Push).
const DEAD_AFTER_HEARTBEATS = 3;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

// How a stream ended: with the server's error (a `terminated` frame or an error response) or a failed send, or without an error.
interface Ending {
    error?: unknown;
}

function endingOf(end: StreamEnd): Ending {
    return end.cause === 'remote' && end.error !== undefined ? { error: asEventsError(end.error) } : {};
}

// A pushed event as every mode yields it: without the stream's subscription id in `_meta`, and without `_meta` when nothing else is in it.
function withoutStreamId(event: EventOccurrence): EventOccurrence {
    if (event._meta === undefined || !(SUBSCRIPTION_ID_META_KEY in event._meta)) return event;
    const { _meta: meta, ...occurrence } = event;
    const rest = Object.fromEntries(Object.entries(meta).filter(([key]) => key !== SUBSCRIPTION_ID_META_KEY));
    return Object.keys(rest).length === 0 ? occurrence : { ...occurrence, _meta: rest };
}

// Push delivery (spec §6.3): one `events/stream` at a time, reopened from the last cursor after a jittered delay whenever it ends.
export class PushDriver<T> implements Driver {
    readonly #context: DriverContext<T>;
    // Aborts a re-list in flight on stop() or a closed connection.
    readonly #abort = new AbortController();
    #cursor: string | null;
    // Sent until a stream is active.
    #maxAgeMs: number | undefined;
    // Until the first `active`, or a transient failure of a stream before it.
    #first = true;
    #subscribed: () => void = () => {};
    // Reconnect delays taken since the last `active`.
    #attempt = 0;
    // A schema change has refused the subscription since the last `active`.
    #schemaChanged = false;
    // A -32020 has been re-listed for since the last `active`.
    #mismatched = false;
    // The cursor was reset to now; the next `active` reports the gap.
    #reset = false;
    #stopped = false;
    // Set by the connection's close listener, which ends the subscription at once.
    #closed = false;
    // The stream last opened; a terminated one stays registered until its final result arrives.
    #handle: StreamHandle | undefined;
    // Ends the wait for the open stream.
    #end: ((ending: Ending) => void) | undefined;
    // The open stream's heartbeat grant, from its last `active`.
    #grantMs: number | undefined;
    #dead: ReturnType<typeof setTimeout> | undefined;
    #wake: (() => void) | undefined;
    #running: Promise<void> = Promise.resolve();

    constructor(context: DriverContext<T>) {
        this.#context = context;
        this.#cursor = context.subscription.cursor ?? null;
        this.#maxAgeMs = context.subscription.maxAgeMs;
    }

    start(): Promise<void> {
        let settle!: { resolve(): void; reject(error: unknown): void };
        const first = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
        const fail = (error: unknown): void => {
            settle.reject(error);
            this.#context.queue.fail(error);
        };
        this.#subscribed = () => {
            this.#first = false;
            settle.resolve();
        };
        const removeCloseListener = this.#context.connection.onClose(() => {
            this.#closed = true;
            this.#interrupt();
            fail(closedError());
        });
        this.#running = this.#run().then(settle.resolve, fail).finally(removeCloseListener);
        return first;
    }

    async stop(): Promise<void> {
        this.#stopped = true;
        this.#interrupt();
        await this.#handle?.close();
        await this.#running;
    }

    // Ends what the loop waits for: the open stream, a re-list or a reconnect delay.
    #interrupt(): void {
        this.#abort.abort();
        this.#wake?.();
        this.#end?.({});
    }

    // Reopens after every end until stopped; throws, ending the subscription, when an end calls for it.
    async #run(): Promise<void> {
        while (!this.#stopped && !this.#closed) {
            const { error } = await this.#open();
            if (this.#stopped || this.#closed) return;
            if (error === undefined) this.#subscribed();
            else await this.#recover(error);
            await this.#sleep(this.#reconnectDelay());
        }
    }

    // After a stream ended with `error` (spec §6.3): throws when that ends the subscription, otherwise readies the reopen.
    async #recover(error: unknown): Promise<void> {
        const { connection, subscription } = this.#context;
        const closed = connectionClosed(connection, error);
        if (closed !== undefined) throw closed;
        const recovery = recoveryFor(error);
        if (recovery === 'mismatch') {
            if (this.#mismatched) throw error;
            this.#mismatched = true;
            await connection.list(undefined, { signal: this.#abort.signal }).catch(() => {});
            return;
        }
        if (this.#first) {
            // A stale cursor passed to subscribe(): drop it and start from now, if the event type is still pushed.
            if (isSchemaChange(error) && this.#cursor !== null) {
                await requireOffered(connection, subscription.name, 'push', this.#abort.signal);
                this.#restartFromNow();
                return;
            }
            if (refusesSubscription(error)) throw error;
            this.#subscribed();
            return;
        }
        if (recovery === 'retry') return;
        if (recovery === 'fail') throw error;
        const offered = await stillOffered(connection, subscription.name, 'push', this.#abort.signal);
        if (offered === false) throw error;
        if (offered === true && isSchemaChange(error)) this.#schemaChange();
    }

    #restartFromNow(): void {
        this.#cursor = null;
        this.#reset = true;
    }

    // A second schema change in a row means the last cursor is refused (SEP: a stale schema epoch), so start again from now.
    #schemaChange(): void {
        if (this.#schemaChanged && this.#cursor !== null) this.#restartFromNow();
        this.#schemaChanged = true;
    }

    // Opens `events/stream` from the last cursor (no `heartbeatMs` suggestion) and resolves with how it ended.
    #open(): Promise<Ending> {
        const { connection, subscription } = this.#context;
        const { name, arguments: args } = subscription;
        const params = {
            name,
            ...(args !== undefined && { arguments: args }),
            cursor: this.#cursor,
            ...(this.#maxAgeMs !== undefined && { maxAgeMs: this.#maxAgeMs })
        };
        const headers = connection.paramHeadersFor(name, args);
        // A terminated stream whose final result has not arrived.
        void this.#handle?.close();
        this.#grantMs = undefined;
        return new Promise(resolve => {
            let ended = false;
            const end = (ending: Ending): void => {
                if (ended) return;
                ended = true;
                clearTimeout(this.#dead);
                this.#end = undefined;
                resolve(ending);
            };
            this.#end = end;
            try {
                this.#handle = clientInternals.openStream(
                    connection.client,
                    { method: EVENTS_STREAM_METHOD, params },
                    {
                        onNotification: notification => {
                            if (!ended) this.#frame(notification, end);
                        },
                        onEnd: streamEnd => end(endingOf(streamEnd))
                    },
                    Object.keys(headers).length === 0 ? undefined : { headers }
                );
            } catch (error) {
                end({ error });
            }
        });
    }

    // One frame of the open stream. `terminated` ends it with the server's error; `notifications/events/error` changes nothing.
    #frame(notification: JSONRPCNotification, end: (ending: Ending) => void): void {
        switch (notification.method) {
            case EVENTS_ACTIVE_NOTIFICATION: {
                const params = this.#parse(EventsActiveNotificationParamsSchema, notification);
                if (params !== undefined) this.#active(params);
                break;
            }
            case EVENTS_EVENT_NOTIFICATION: {
                const params = this.#parse(EventNotificationParamsSchema, notification);
                if (params === undefined) break;
                this.#context.queue.push(withoutStreamId(params));
                this.#setCursor(params.cursor ?? null);
                break;
            }
            case EVENTS_HEARTBEAT_NOTIFICATION: {
                const params = this.#parse(EventsHeartbeatNotificationParamsSchema, notification);
                if (params !== undefined) this.#setCursor(params.cursor ?? null);
                break;
            }
            case EVENTS_TERMINATED_NOTIFICATION: {
                const params = this.#parse(EventsTerminatedNotificationParamsSchema, notification);
                if (params === undefined) break;
                const { code, message, data } = params.error;
                end({ error: asEventsError(ProtocolError.fromError(code, message, data)) });
                return;
            }
        }
        this.#alive(end);
    }

    // Every `active` carries the heartbeat grant and the position delivery starts from; `truncated` reports a gap.
    #active(params: EventsActiveNotificationParams): void {
        const { connection, subscription } = this.#context;
        const cursor = params.cursor ?? null;
        const reset = this.#reset;
        this.#grantMs = params.heartbeatMs;
        this.#attempt = 0;
        this.#schemaChanged = false;
        this.#mismatched = false;
        this.#reset = false;
        this.#maxAgeMs = undefined;
        // A type without replay has no position to have skipped past (SEP: ignore `truncated`).
        if (reset || (params.truncated === true && cursor !== null)) reportGap(subscription, connection, cursor);
        this.#setCursor(cursor);
        this.#subscribed();
    }

    // From `active` on, every message restarts the countdown to declaring the stream dead and reconnecting.
    #alive(end: (ending: Ending) => void): void {
        if (this.#grantMs === undefined) return;
        clearTimeout(this.#dead);
        this.#dead = setTimeout(
            () => {
                end({});
                void this.#handle?.close();
            },
            Math.min(DEAD_AFTER_HEARTBEATS * this.#grantMs, MAX_TIMER_DELAY_MS)
        );
    }

    #setCursor(cursor: string | null): void {
        this.#cursor = cursor;
        this.#context.queue.setCursor(cursor);
    }

    // The frame's params, or `undefined` (reported to onerror) when they do not match the schema.
    #parse<S extends z.ZodType>(schema: S, notification: JSONRPCNotification): z.output<S> | undefined {
        const parsed = schema.safeParse(notification.params);
        if (parsed.success) return parsed.data;
        this.#context.connection.report(new Error(`Invalid ${notification.method} params: ${parsed.error.message}`));
        return undefined;
    }

    // random() × min(30 s, 1 s × 2^attempt), attempts counted since the last `active` (SEP: jitter before reconnecting).
    #reconnectDelay(): number {
        return Math.random() * Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.#attempt++);
    }

    #sleep(ms: number): Promise<void> {
        return new Promise(resolve => {
            if (this.#stopped || this.#closed) return resolve();
            const wake = (): void => {
                clearTimeout(timer);
                this.#wake = undefined;
                resolve();
            };
            const timer = setTimeout(wake, ms);
            this.#wake = wake;
        });
    }
}
