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
import { EventsError } from '@modelcontextprotocol/core-internal/ext/events';
import { DEFAULT_REQUEST_TIMEOUT_MSEC, SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal/public';
import type * as z from 'zod/v4';

import { isAuthSeamEscape } from '../../client/authSeam';
import type { StreamEnd, StreamHandle } from '../../client/client';
import { clientInternals } from '../../client/client';
import { connectionClosed, DriverLoop, endsSubscription, isHeaderMismatch, jitteredDelay, MAX_TIMER_DELAY_MS } from './recovery';
import { asEventsError } from './request';
import type { Driver, DriverContext } from './subscription';

// No message for this many granted heartbeat intervals, counted from `active`, means the stream is dead (SEP-3415 §Push).
const DEAD_AFTER_HEARTBEATS = 3;

// How a stream ended: with the server's error (a `terminated` frame or an error response) or a failed send, or without an error.
interface Ending {
    error?: unknown;
}

// The first stream of a subscription that may fall back ended before a valid `active`, with `cause`, which is not the server's refusal.
export class PushUnavailableError extends Error {
    constructor(name: string, cause: unknown) {
        super(`${EVENTS_STREAM_METHOD} for '${name}' failed before its first ${EVENTS_ACTIVE_NOTIFICATION}; subscribing by poll instead`, {
            cause
        });
    }
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
    readonly #loop: DriverLoop<T>;
    // A first stream that cannot work rejects start() with PushUnavailableError, for subscribe() to poll instead.
    readonly #fallback: boolean;
    // Reconnect delays taken since the last `active`.
    #attempt = 0;
    // A -32020 has been re-listed for since the last `active`.
    #mismatched = false;
    // The stream last opened; a terminated one stays registered until its final result arrives.
    #handle: StreamHandle | undefined;
    // Ends the wait for the open stream.
    #end: ((ending: Ending) => void) | undefined;
    // The open (or last) stream's heartbeat grant, from its last `active`; `undefined` until it has had one.
    #grantMs: number | undefined;
    // Until the first valid `active`, the wait for it; from then on, the countdown to declaring the stream dead.
    #dead: ReturnType<typeof setTimeout> | undefined;

    constructor(context: DriverContext<T>, fallback = false) {
        this.#context = context;
        this.#loop = new DriverLoop(context, 'push');
        this.#fallback = fallback;
    }

    start(): Promise<void> {
        return this.#loop.start(() => this.#run(), { interrupt: () => this.#end?.({}) });
    }

    stop(): Promise<void> {
        return this.#loop.stop(async () => {
            await this.#handle?.close();
        });
    }

    // Reopens after every end until stopped; throws, ending the subscription, when an end calls for it.
    async #run(): Promise<void> {
        const loop = this.#loop;
        while (!loop.ended) {
            const { error } = await this.#open();
            if (loop.ended) return;
            // A stream that ends before its first valid `active` (no grant yet) failed, as one that times out waiting for it does.
            const failure =
                error ??
                (this.#grantMs === undefined
                    ? new SdkError(
                          SdkErrorCode.InvalidResult,
                          `${EVENTS_STREAM_METHOD} ended before its first valid ${EVENTS_ACTIVE_NOTIFICATION}`
                      )
                    : undefined);
            if (failure !== undefined) await this.#recover(failure);
            await loop.sleep(jitteredDelay(this.#attempt++));
        }
    }

    // After a stream ended with `error` (spec §6.3): throws when that ends the subscription, otherwise readies the reopen.
    async #recover(error: unknown): Promise<void> {
        // An `events/stream` is not sent through `request()`, so its first -32020 since the last `active` re-lists here.
        if (isHeaderMismatch(error) && !this.#mismatched) {
            this.#mismatched = true;
            await this.#context.connection.list(undefined, { signal: this.#loop.signal }).catch(() => {});
            return;
        }
        const { connection, subscription } = this.#context;
        // An auth failure, even one retried, says nothing about push itself.
        const unavailable =
            !(error instanceof EventsError) &&
            !isAuthSeamEscape(error) &&
            !endsSubscription(error) &&
            connectionClosed(connection, error) === undefined;
        if (this.#fallback && this.#loop.first && unavailable) throw new PushUnavailableError(subscription.name, error);
        await this.#loop.recover(error);
    }

    // Opens `events/stream` from the last cursor (no `heartbeatMs` suggestion) and resolves with how it ended.
    #open(): Promise<Ending> {
        const { connection, subscription } = this.#context;
        const { name, arguments: args } = subscription;
        const loop = this.#loop;
        const { maxAgeMs } = loop;
        const params = {
            name,
            ...(args !== undefined && { arguments: args }),
            cursor: loop.cursor,
            ...(maxAgeMs !== undefined && { maxAgeMs })
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
            // Bounded as listen() bounds its ack: with no valid `active` in time, the stream fails as a timed-out request does.
            this.#dead = setTimeout(
                () =>
                    this.#fault(
                        end,
                        new SdkError(
                            SdkErrorCode.RequestTimeout,
                            `${EVENTS_STREAM_METHOD}: no valid ${EVENTS_ACTIVE_NOTIFICATION} in time`,
                            {
                                timeout: DEFAULT_REQUEST_TIMEOUT_MSEC
                            }
                        )
                    ),
                DEFAULT_REQUEST_TIMEOUT_MSEC
            );
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
                if (params === undefined) {
                    this.#fault(end, new SdkError(SdkErrorCode.InvalidResult, `Invalid ${EVENTS_ACTIVE_NOTIFICATION} params`));
                    return;
                }
                this.#active(params);
                break;
            }
            case EVENTS_EVENT_NOTIFICATION: {
                const params = this.#parse(EventNotificationParamsSchema, notification);
                if (params === undefined) break;
                this.#context.queue.push(withoutStreamId(params));
                this.#loop.setCursor(params.cursor ?? null);
                break;
            }
            case EVENTS_HEARTBEAT_NOTIFICATION: {
                const params = this.#parse(EventsHeartbeatNotificationParamsSchema, notification);
                if (params === undefined) break;
                this.#loop.setCursor(params.cursor ?? null);
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
        const cursor = params.cursor ?? null;
        this.#grantMs = params.heartbeatMs;
        this.#attempt = 0;
        this.#mismatched = false;
        this.#loop.succeeded(cursor, params.truncated === true);
        this.#loop.setCursor(cursor);
        this.#loop.subscribed();
    }

    // From `active` on, every message restarts the countdown to declaring the stream dead, unless a callback in the frame already ended it.
    #alive(end: (ending: Ending) => void): void {
        if (this.#grantMs === undefined || this.#end !== end) return;
        clearTimeout(this.#dead);
        this.#dead = setTimeout(() => this.#fault(end, undefined), Math.min(DEAD_AFTER_HEARTBEATS * this.#grantMs, MAX_TIMER_DELAY_MS));
    }

    // Ends the open stream from this side, with `error` for the recovery to judge, and closes its request.
    #fault(end: (ending: Ending) => void, error: unknown): void {
        end(error === undefined ? {} : { error });
        void this.#handle?.close();
    }

    // The frame's params, or `undefined` (reported to onerror) when they do not match the schema.
    #parse<S extends z.ZodType>(schema: S, notification: JSONRPCNotification): z.output<S> | undefined {
        const parsed = schema.safeParse(notification.params);
        if (parsed.success) return parsed.data;
        this.#context.connection.report(new Error(`Invalid ${notification.method} params: ${parsed.error.message}`));
        return undefined;
    }
}
