import type {
    EventOccurrence,
    EventsErrorObject,
    StreamEventsRequestParams,
    StreamEventsResult
} from '@modelcontextprotocol/core/ext/events';
import {
    EVENTS_ACTIVE_NOTIFICATION,
    EVENTS_ERROR_NOTIFICATION,
    EVENTS_EVENT_NOTIFICATION,
    EVENTS_HEARTBEAT_NOTIFICATION,
    EVENTS_TERMINATED_NOTIFICATION
} from '@modelcontextprotocol/core/ext/events';
import type { RequestId, ServerContext } from '@modelcontextprotocol/core-internal';
import { ProtocolErrorCode, SUBSCRIPTION_ID_META_KEY } from '@modelcontextprotocol/core-internal';
import type { EventsErrorKind } from '@modelcontextprotocol/core-internal/ext/events';
import { EventsError } from '@modelcontextprotocol/core-internal/ext/events';

import type { ResponseFlow } from '../../server/perRequestTransport';
import { makeContext } from './context';
import type { BufferedEvent, EmitBuffer } from './emitBuffer';
import type { SubscriptionSource } from './extension';
import { checkedEvents, checkedSelection, DEFAULT_MAX_EVENTS, selectEvent } from './poll';
import type { RegisteredEvent } from './registry';
import type { CheckContext, EventContext, EventResult } from './types';
import type { SubscriptionValidator } from './validation';

// The shortest heartbeat granted, whatever the client suggests.
const HEARTBEAT_FLOOR_MS = 5000;
// No frame goes to the transport while the client has more than this unread; a stream that stays over it for a whole heartbeat interval is abandoned.
const MAX_STREAM_BACKLOG_BYTES = 1_048_576;
// setTimeout fires at once for longer delays, so a longer heartbeat grant or check interval runs early.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

// A check that throws one of these ends its subscription; any other error leaves the loop running.
export const TERMINAL_KINDS: ReadonlySet<EventsErrorKind> = new Set(['forbidden', 'notFound', 'unsupported']);

export interface PushDeps {
    readonly validator: SubscriptionValidator;
    readonly buffer: EmitBuffer;
    // The grant when the client suggests none, and the longest granted.
    readonly heartbeatMs: number;
    readonly checkIntervalMs: number;
    report(error: unknown): void;
}

interface PushStream {
    // The registration it serves; an update() replaces it with the updated one.
    entry: RegisteredEvent;
    readonly args: Record<string, unknown>;
    readonly requestId: RequestId;
    readonly grant: number;
    readonly notify: ServerContext['mcpReq']['notify'];
    // Where the transport tells: the bytes the client has not read, a wait for it to read, and the abort that drops them; and since when they have been over the bound.
    readonly flow?: ResponseFlow;
    overSince?: number;
    // The events queued that have not been handed to the transport or dropped yet.
    waiting: number;
    // Since when the transport has held the frame being written.
    writingSince?: number;
    // Since when `waiting` has been at least the emit buffer's `maxEvents`.
    fullSince?: number;
    // The stream ended by the client's cancellation or an abandon, so its queued events and heartbeats are not written.
    dropping: boolean;
    // Ends the current wait for room, and the drain epoch the stream already waits on, so a wait that times out leaves nothing behind.
    wake?: () => void;
    epoch?: Promise<void>;
    // Aborts when the stream ends; the `signal` of every callback's ctx.
    readonly ended: AbortController;
    readonly ctx: CheckContext;
    // A check type's stream opened with a cursor and `maxAgeMs`: the request's receipt time less `maxAgeMs`, before which no `check` run of it delivers an event.
    readonly floor: number | undefined;
    // Resolves once the stream has ended and its last message is written.
    readonly done: Promise<void>;
    finish(): void;
    // From the first `active` on; until then an end is only recorded, and `open` acts on it.
    live: boolean;
    stopped?: { error?: EventsError };
    // The position checked up to, which a heartbeat carries.
    position: string | null;
    // Notifications in the order they were sent.
    queue: Promise<void>;
    heartbeat?: ReturnType<typeof setTimeout>;
    checkTimer?: ReturnType<typeof setTimeout>;
    // The pages being read continue a run of truncated ones the client was already told of.
    skipping: boolean;
}

// What a subscription sends next: its start or gap at `cursor` when one is due, then `events`, after which it is at `position`; `hasMore` when the `check` page left more waiting.
export interface Batch {
    readonly cursor: string | null;
    readonly truncated: boolean;
    readonly events: readonly EventOccurrence[];
    readonly position: string | null;
    readonly hasMore?: boolean;
}

// Timers never keep the process alive on their own.
function unref(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
    (timer as { unref?: () => void }).unref?.();
    return timer;
}

// Resolves once the client reads what is queued, or after `ms`, or on `stream.wake()`; the stream follows each drain epoch once.
function untilDrained(stream: PushStream, flow: ResponseFlow, ms: number): Promise<void> {
    const epoch = flow.drained();
    if (stream.epoch !== epoch) {
        stream.epoch = epoch;
        void epoch.then(() => stream.wake?.());
    }
    return new Promise(resolve => {
        const wake = (): void => {
            clearTimeout(timer);
            if (stream.wake === wake) stream.wake = undefined;
            resolve();
        };
        const timer = unref(setTimeout(wake, Math.min(ms, MAX_TIMER_DELAY_MS)));
        stream.wake = wake;
    });
}

// The `error` of `notifications/events/{error,terminated}` and the webhook `terminated` body: an `EventsError` as it is, anything else as -32603.
export function errorObject(error: unknown): EventsErrorObject {
    if (error instanceof EventsError) {
        return {
            code: error.code,
            message: error.message,
            ...(error.data === undefined ? {} : { data: error.data as Record<string, unknown> })
        };
    }
    return { code: ProtocolErrorCode.InternalError, message: error instanceof Error ? error.message : String(error) };
}

// A batch's cursors, its start or gap cursor too, stay at `from` until its last event, truncated or not, so none runs ahead of an unsent event.
export async function checkedBatch(
    entry: RegisteredEvent,
    from: string | null,
    result: EventResult<unknown>,
    maxAgeMs: number | undefined,
    report: (error: unknown) => void
): Promise<Batch> {
    const { events, truncated } = await checkedEvents(entry, result, maxAgeMs, report);
    const last = events.length - 1;
    const cursorAt = (index: number) => (index === last ? result.cursor : from);
    return {
        cursor: cursorAt(-1),
        truncated,
        events: events.map((occurrence, index) => ({ ...occurrence, cursor: cursorAt(index) })),
        position: result.cursor,
        hasMore: result.hasMore === true
    };
}

// A page that left more waiting and moved on (events, or a new cursor) is followed by the next `check` at once; one that made no progress waits the interval.
export function pagesOn(batch: Batch, from: string | null): boolean {
    return batch.hasMore === true && (batch.events.length > 0 || batch.position !== from);
}

// The `maxAgeMs` of a check run against a fixed `floor`: the time since it.
export function maxAgeSince(floor: number | undefined): number | undefined {
    return floor === undefined ? undefined : Math.max(0, Date.now() - floor);
}

// The floor of a subscription whose request carries `cursor` and `maxAgeMs`, taken as it is received; the spec ignores `maxAgeMs` with a null cursor.
export function floorOf(cursor: string | null | undefined, maxAgeMs: number | undefined): number | undefined {
    return cursor === null || cursor === undefined || maxAgeMs === undefined ? undefined : Date.now() - maxAgeMs;
}

// Where a check type starts: `null` takes the current cursor, a cursor replays the events since it first.
export async function startCheck(
    entry: RegisteredEvent,
    ctx: CheckContext,
    args: Record<string, unknown>,
    from: string | null,
    maxAgeMs: number | undefined,
    report: (error: unknown) => void
): Promise<Batch> {
    const check = entry.definition.check!;
    if (from === null) {
        const { cursor } = await check(ctx, args, null);
        return { cursor, truncated: false, events: [], position: cursor };
    }
    const result = await check(makeContext({ ...ctx, maxAgeMs }), args, from);
    return checkedBatch(entry, from, result, maxAgeMs, report);
}

// Where an emit-only type starts: `null` is the buffer head, a cursor replays the buffer since it, each event at its own position.
export function replayBuffer(
    buffer: EmitBuffer,
    entry: RegisteredEvent,
    ctx: EventContext,
    args: Record<string, unknown>,
    from: string | null,
    maxAgeMs: number | undefined,
    report: (error: unknown) => void
): Batch {
    const { name } = entry;
    if (from === null) {
        const head = buffer.head(name);
        return { cursor: head, truncated: false, events: [], position: head };
    }
    const select = (buffered: BufferedEvent) => selectEvent(entry, ctx, args, buffered, report);
    // `maxEvents: 0` finds where replay starts (after a gap or the `maxAgeMs` floor) without reading an event.
    const start = buffer.read(name, from, { maxEvents: 0, maxAgeMs, select });
    const events: EventOccurrence[] = [];
    let { cursor: position, hasMore } = start;
    while (hasMore) {
        const read = buffer.read(name, position, { maxEvents: 1, select });
        for (const occurrence of read.events) events.push({ ...occurrence, cursor: read.cursor });
        ({ cursor: position, hasMore } = read);
    }
    return { cursor: events.length === 0 ? position : start.cursor, truncated: start.truncated, events, position };
}

// `events/stream`: one long-lived request per subscription, answered with `notifications/events/*` until it ends (SEP-3415 §Push).
export class StreamSet implements SubscriptionSource {
    readonly #deps: PushDeps;
    readonly #streams = new Set<PushStream>();

    constructor(deps: PushDeps) {
        this.#deps = deps;
    }

    get size(): number {
        return this.#streams.size;
    }

    countOf(principal: string | null): number {
        let count = 0;
        for (const stream of this.#streams) if (stream.ctx.principal === principal) count += 1;
        return count;
    }

    // `flow` paces the writes to the response stream, on a transport that can tell how far the client has read.
    async open(params: StreamEventsRequestParams, ctx: ServerContext, flow?: ResponseFlow): Promise<StreamEventsResult> {
        const floor = floorOf(params.cursor, params.maxAgeMs);
        const { entry, principal, args } = await this.#deps.validator.validate('push', params, ctx);
        this.#deps.validator.assertCapacity(principal);
        const stream = this.#create(entry, principal, args, params, ctx, flow, entry.kind === 'check' ? floor : undefined);
        const result = { _meta: { [SUBSCRIPTION_ID_META_KEY]: ctx.mcpReq.id } };
        // A termination meanwhile answers as itself, not as the abort it caused in a hook that honours `ctx.signal`.
        try {
            await entry.definition.onSubscribe?.(stream.ctx, args);
        } catch (error) {
            this.#streams.delete(stream);
            stream.ended.abort();
            throw stream.stopped?.error ?? error;
        }
        let checked: Batch | undefined;
        try {
            if (entry.kind === 'check' && stream.stopped === undefined) {
                const ctx = makeContext({ ...stream.ctx, maxEvents: DEFAULT_MAX_EVENTS });
                checked = await startCheck(entry, ctx, args, params.cursor ?? null, maxAgeSince(floor), this.#deps.report);
            }
        } catch (error) {
            await this.#abandon(stream);
            throw stream.stopped?.error ?? error;
        }
        // Ended before `active`: no stream opened, so a termination answers as the request's error.
        if (stream.stopped !== undefined) {
            await this.#abandon(stream);
            if (stream.stopped.error !== undefined) throw stream.stopped.error;
            return result;
        }
        // Synchronous from the replay read to going live, so no emit falls between them.
        stream.live = true;
        const { buffer, report } = this.#deps;
        const from = params.cursor ?? null;
        // The start batch does not count against the waiting-event cap, so live events get all of it after a full replay.
        this.#send(
            stream,
            checked ?? replayBuffer(buffer, stream.entry, stream.ctx, stream.args, from, params.maxAgeMs, report),
            true,
            false
        );
        const more = checked !== undefined && pagesOn(checked, from);
        // The start's `active` told of its truncation, so the pages that continue the run do not again.
        stream.skipping = checked?.truncated === true && more;
        this.#scheduleCheck(stream, more);
        await stream.done;
        return result;
    }

    // Delivers an emitted event to every live stream of its type; it only queues writes.
    fanOut(name: string, buffered: BufferedEvent, cursor: string): void {
        for (const stream of this.#streams) {
            if (!stream.live || stream.entry.name !== name) continue;
            stream.position = cursor;
            const occurrence = selectEvent(stream.entry, stream.ctx, stream.args, buffered, this.#deps.report);
            if (occurrence !== undefined) this.#writeEvent(stream, { ...occurrence, cursor });
        }
    }

    // Moves the streams of `previous` to its updated registration, so their next batch parses with its schemas.
    update(previous: RegisteredEvent, next: RegisteredEvent): void {
        for (const stream of this.#streams) if (stream.entry === previous) stream.entry = next;
    }

    // Sends `terminated` on each matching stream, runs onUnsubscribe, and ends the request with its final result.
    async terminate(name: string, error: EventsError, subscriptionId?: string): Promise<void> {
        const ending: Promise<void>[] = [];
        for (const stream of this.#streams) {
            if (stream.entry.name !== name || (subscriptionId !== undefined && stream.ctx.subscriptionId !== subscriptionId)) continue;
            ending.push(this.#end(stream, error));
        }
        await Promise.all(ending);
    }

    // Ends every stream with its final result and runs onUnsubscribe, for a simulated restart.
    closeAll(): void {
        for (const stream of this.#streams) this.#drop(stream);
    }

    #create(
        entry: RegisteredEvent,
        principal: string | null,
        args: Record<string, unknown>,
        params: StreamEventsRequestParams,
        ctx: ServerContext,
        flow: ResponseFlow | undefined,
        floor: number | undefined
    ): PushStream {
        let finish!: () => void;
        const done = new Promise<void>(resolve => (finish = resolve));
        const ended = new AbortController();
        const max = this.#deps.heartbeatMs;
        const stream: PushStream = {
            entry,
            args,
            requestId: ctx.mcpReq.id,
            grant: Math.min(Math.max(params.heartbeatMs ?? max, HEARTBEAT_FLOOR_MS), max),
            notify: ctx.mcpReq.notify,
            ...(flow !== undefined && { flow }),
            ended,
            ctx: makeContext({
                name: entry.name,
                subscriptionId: globalThis.crypto.randomUUID(),
                principal,
                mode: 'push',
                signal: ended.signal
            }),
            floor,
            done,
            finish,
            live: false,
            position: null,
            queue: Promise.resolve(),
            waiting: 0,
            dropping: false,
            skipping: false
        };
        this.#streams.add(stream);
        // The client went away: an HTTP abort or `notifications/cancelled`.
        const { signal } = ctx.mcpReq;
        signal.addEventListener('abort', () => this.#drop(stream), { once: true });
        if (signal.aborted) this.#drop(stream);
        return stream;
    }

    #send(stream: PushStream, batch: Batch, active: boolean, counted = true): void {
        if (active) {
            this.#write(stream, EVENTS_ACTIVE_NOTIFICATION, {
                cursor: batch.cursor,
                truncated: batch.truncated,
                heartbeatMs: stream.grant
            });
        }
        for (const event of batch.events) this.#writeEvent(stream, event, counted);
        stream.position = batch.position;
    }

    // Writes an event that checkedSelection passes, in order with the stream's other writes; `counted` ones count against the waiting-event cap.
    #writeEvent(stream: PushStream, event: EventOccurrence, counted = true): void {
        this.#write(stream, EVENTS_EVENT_NOTIFICATION, checkedSelection(stream.entry, event, this.#deps.report), counted);
    }

    // The next check runs once this one's frames reached the transport, so a client that reads slowly holds one batch at most: at once after a page with more waiting, otherwise an interval later.
    #scheduleCheck(stream: PushStream, now = false): void {
        if (!stream.live || stream.entry.kind !== 'check') return;
        void stream.queue.then(() => {
            if (!stream.live) return;
            const delay = now ? 0 : Math.min(this.#deps.checkIntervalMs, MAX_TIMER_DELAY_MS);
            stream.checkTimer = unref(setTimeout(() => void this.#check(stream), delay));
        });
    }

    // Each run reads at most DEFAULT_MAX_EVENTS events, as a poll page does.
    async #check(stream: PushStream): Promise<void> {
        const from = stream.position;
        const maxAgeMs = maxAgeSince(stream.floor);
        const ctx = makeContext({ ...stream.ctx, maxEvents: DEFAULT_MAX_EVENTS, maxAgeMs });
        let more = false;
        try {
            const result = await stream.entry.definition.check!(ctx, stream.args, from);
            const batch = await checkedBatch(stream.entry, from, result, maxAgeMs, this.#deps.report);
            if (!stream.live) return;
            // One `active { truncated: true }` per run of truncated pages (a stale cursor's catch-up under `maxAgeMs`, say).
            this.#send(stream, batch, batch.truncated && !stream.skipping);
            more = pagesOn(batch, from);
            stream.skipping = batch.truncated && more;
        } catch (error) {
            if (!stream.live) return;
            if (error instanceof EventsError && TERMINAL_KINDS.has(error.kind)) {
                void this.#end(stream, error);
                return;
            }
            this.#write(stream, EVENTS_ERROR_NOTIFICATION, { error: errorObject(error) });
        }
        this.#scheduleCheck(stream, more);
    }

    // Params that resolve to `undefined` (a dropped event) send nothing; an event's own `_meta` keys stay beside the stream's id.
    #write(
        stream: PushStream,
        method: string,
        params: Record<string, unknown> | Promise<Record<string, unknown> | undefined>,
        event = false
    ): void {
        const { flow } = stream;
        const { maxEvents } = this.#deps.buffer;
        if (event) {
            // An emit-only stream with more live events waiting than the emit buffer holds is abandoned as a stalled one is, once its transport is not taking its frames, or on stdio has not got below that for a whole grant.
            if (stream.entry.kind === 'emitOnly' && stream.waiting >= maxEvents && this.#stalled(stream)) {
                this.#dropStalled(stream);
                return;
            }
            stream.waiting += 1;
            if (stream.waiting >= maxEvents) stream.fullSince ??= Date.now();
        }
        const queuedAfterEnd = stream.ended.signal.aborted;
        // A failed write means the client is gone.
        stream.queue = stream.queue
            .then(async () => {
                try {
                    const resolved = await params;
                    if (resolved === undefined || !(await this.#room(stream))) return;
                    if (!this.#writesAfterEnd(stream, method, queuedAfterEnd)) return;
                    const _meta = {
                        ...(resolved._meta as Record<string, unknown> | undefined),
                        [SUBSCRIPTION_ID_META_KEY]: stream.requestId
                    };
                    stream.writingSince = Date.now();
                    try {
                        await stream.notify({ method, params: { ...resolved, _meta } });
                    } finally {
                        stream.writingSince = undefined;
                    }
                    if ((flow?.backlog() ?? 0) > MAX_STREAM_BACKLOG_BYTES) stream.overSince ??= Date.now();
                    this.#armHeartbeat(stream);
                } finally {
                    if (event) {
                        stream.waiting -= 1;
                        if (stream.waiting < maxEvents) stream.fullSince = undefined;
                    }
                }
            })
            .catch(() => this.#drop(stream));
    }

    // Over HTTP, the client has more than the bound unread; on a transport that cannot tell how far its client has read (stdio), the frame it holds has waited longer than the grant, or the events waiting have stayed at the cap for a whole grant, so a burst queued while it keeps writing does not count.
    #stalled(stream: PushStream): boolean {
        const { flow, writingSince, fullSince } = stream;
        if (flow !== undefined) return flow.backlog() > MAX_STREAM_BACKLOG_BYTES;
        const now = Date.now();
        return (
            (writingSince !== undefined && now - writingSince > stream.grant) ||
            (fullSince !== undefined && now - fullSince >= stream.grant)
        );
    }

    // Whether a frame still goes out once the stream has ended: `terminated` does; a heartbeat does not; an event or error queued before a server-side end (terminate(), remove(), a schema change, a terminal `check`) does, unless the end was the client's cancellation or an abandon.
    #writesAfterEnd(stream: PushStream, method: string, queuedAfterEnd: boolean): boolean {
        if (!stream.ended.signal.aborted || method === EVENTS_TERMINATED_NOTIFICATION) return true;
        return method !== EVENTS_HEARTBEAT_NOTIFICATION && !queuedAfterEnd && !stream.dropping;
    }

    // A heartbeat once the stream has been quiet for its grant, timed from the last frame written, so frames that send nothing do not hold it back.
    #armHeartbeat(stream: PushStream): void {
        if (!stream.live) return;
        clearTimeout(stream.heartbeat);
        stream.heartbeat = unref(
            setTimeout(
                () => this.#write(stream, EVENTS_HEARTBEAT_NOTIFICATION, { cursor: stream.position }),
                Math.min(stream.grant, MAX_TIMER_DELAY_MS)
            )
        );
    }

    // Waits while the client has more than the bound unread, so a replay or a burst goes out at its pace; once that lasts a whole grant, or at once for a stream that has ended, the stream is abandoned and nothing more is written.
    async #room(stream: PushStream): Promise<boolean> {
        const { flow } = stream;
        if (flow === undefined) return true;
        while (flow.backlog() > MAX_STREAM_BACKLOG_BYTES) {
            const now = Date.now();
            stream.overSince ??= now;
            const left = stream.overSince + stream.grant - now;
            if (left <= 0 || stream.ended.signal.aborted) {
                this.#dropStalled(stream);
                return false;
            }
            await untilDrained(stream, flow, left);
        }
        stream.overSince = undefined;
        return true;
    }

    // A client that stopped reading, or on stdio left `emitBuffer.maxEvents` events waiting for a whole grant: the subscription ends, and over HTTP the response body errors, which drops its unread bytes; on stdio its final result follows what the transport already holds. Either way the SDK's client reconnects from its cursor.
    #dropStalled(stream: PushStream): void {
        this.#drop(stream);
        stream.flow?.abort();
    }

    // The client cancelled, went away or is abandoned: the stream ends, and none of its queued events or heartbeats is written.
    #drop(stream: PushStream): void {
        stream.dropping = true;
        void this.#end(stream);
    }

    // Ends a stream once. A live one sends `terminated` for an error after the frames queued before it and resolves once onUnsubscribe ran, and `open` returns once those frames are written; one not yet live is only marked, for `open` to act on; one whose client is over the bound, now or as its last frames go out (#room), is abandoned at once instead of waiting for room.
    #end(stream: PushStream, error?: EventsError): Promise<void> {
        if (!this.#streams.delete(stream)) return Promise.resolve();
        stream.ended.abort();
        clearTimeout(stream.heartbeat);
        clearTimeout(stream.checkTimer);
        const { flow } = stream;
        if (flow !== undefined && flow.backlog() > MAX_STREAM_BACKLOG_BYTES) {
            stream.dropping = true;
            flow.abort();
        }
        // A frame waiting for room checks it again now, so the last frames go out without waiting for the deadline.
        stream.wake?.();
        if (!stream.live) {
            stream.stopped = error === undefined ? {} : { error };
            return Promise.resolve();
        }
        stream.live = false;
        if (error !== undefined) this.#write(stream, EVENTS_TERMINATED_NOTIFICATION, { error: errorObject(error) });
        const unsubscribed = this.#unsubscribe(stream);
        void unsubscribed.then(() => stream.queue).then(() => stream.finish());
        return unsubscribed;
    }

    // A stream that ended before `active`, after its onSubscribe ran.
    async #abandon(stream: PushStream): Promise<void> {
        this.#streams.delete(stream);
        stream.ended.abort();
        await this.#unsubscribe(stream);
    }

    async #unsubscribe(stream: PushStream): Promise<void> {
        try {
            await stream.entry.definition.onUnsubscribe?.(stream.ctx, stream.args);
        } catch (error) {
            this.#deps.report(error);
        }
    }
}
