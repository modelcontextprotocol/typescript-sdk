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

import { makeContext } from './context';
import type { BufferedEvent, EmitBuffer } from './emitBuffer';
import type { SubscriptionSource } from './extension';
import { checkedEvents, selectEvent } from './poll';
import type { RegisteredEvent } from './registry';
import type { CheckContext, EventResult } from './types';
import type { SubscriptionValidator } from './validation';

// The shortest heartbeat granted, whatever the client suggests (D33).
const HEARTBEAT_FLOOR_MS = 5000;

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
    readonly entry: RegisteredEvent;
    readonly args: Record<string, unknown>;
    readonly requestId: RequestId;
    readonly grant: number;
    readonly notify: ServerContext['mcpReq']['notify'];
    // Aborts when the stream ends; the `signal` of every callback's ctx.
    readonly ended: AbortController;
    readonly ctx: CheckContext;
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
}

// What a subscription sends next: its start or gap at `cursor` when one is due, then `events`, after which it is at `position`.
export interface Batch {
    readonly cursor: string | null;
    readonly truncated: boolean;
    readonly events: readonly EventOccurrence[];
    readonly position: string | null;
}

// Timers never keep the process alive on their own.
function unref(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
    (timer as { unref?: () => void }).unref?.();
    return timer;
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

// A batch's cursors stay at `from` until its last event, so none runs ahead of an unsent event; a truncated batch carries the fresh cursor throughout.
export async function checkedBatch(
    entry: RegisteredEvent,
    from: string | null,
    result: EventResult<unknown>,
    maxAgeMs: number | undefined,
    report: (error: unknown) => void
): Promise<Batch> {
    const { events, truncated } = await checkedEvents(entry, result, maxAgeMs, report);
    const last = events.length - 1;
    const cursorAt = (index: number) => (truncated || index === last ? result.cursor : from);
    return {
        cursor: cursorAt(-1),
        truncated,
        events: events.map((occurrence, index) => ({ ...occurrence, cursor: cursorAt(index) })),
        position: result.cursor
    };
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

    async open(params: StreamEventsRequestParams, ctx: ServerContext): Promise<StreamEventsResult> {
        const { entry, principal, args } = await this.#deps.validator.validate('push', params, ctx);
        this.#deps.validator.assertCapacity();
        const stream = this.#create(entry, principal, args, params, ctx);
        const result = { _meta: { [SUBSCRIPTION_ID_META_KEY]: ctx.mcpReq.id } };
        try {
            await entry.definition.onSubscribe?.(stream.ctx, args);
        } catch (error) {
            this.#streams.delete(stream);
            stream.ended.abort();
            throw error;
        }
        let checked: Batch | undefined;
        try {
            if (entry.kind === 'check' && stream.stopped === undefined) {
                checked = await startCheck(entry, stream.ctx, args, params.cursor ?? null, params.maxAgeMs, this.#deps.report);
            }
        } catch (error) {
            await this.#abandon(stream);
            throw error;
        }
        // Ended before `active`: no stream opened, so a termination answers as the request's error.
        if (stream.stopped !== undefined) {
            await this.#abandon(stream);
            if (stream.stopped.error !== undefined) throw stream.stopped.error;
            return result;
        }
        // Synchronous from the replay read to going live, so no emit falls between them.
        stream.live = true;
        this.#send(stream, checked ?? this.#replay(stream, params), true);
        this.#scheduleCheck(stream);
        await stream.done;
        return result;
    }

    // Delivers an emitted event to every live stream of its type; it only queues writes.
    fanOut(name: string, buffered: BufferedEvent, cursor: string): void {
        for (const stream of this.#streams) {
            if (!stream.live || stream.entry.name !== name) continue;
            stream.position = cursor;
            const occurrence = selectEvent(stream.entry, stream.ctx, stream.args, buffered, this.#deps.report);
            if (occurrence !== undefined) this.#write(stream, EVENTS_EVENT_NOTIFICATION, { ...occurrence, cursor });
        }
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
        for (const stream of this.#streams) void this.#end(stream);
    }

    #create(
        entry: RegisteredEvent,
        principal: string | null,
        args: Record<string, unknown>,
        params: StreamEventsRequestParams,
        ctx: ServerContext
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
            ended,
            ctx: makeContext({
                name: entry.name,
                subscriptionId: globalThis.crypto.randomUUID(),
                principal,
                mode: 'push',
                signal: ended.signal
            }),
            done,
            finish,
            live: false,
            position: null,
            queue: Promise.resolve()
        };
        this.#streams.add(stream);
        // The client went away: an HTTP abort or `notifications/cancelled`.
        const { signal } = ctx.mcpReq;
        signal.addEventListener('abort', () => void this.#end(stream), { once: true });
        if (signal.aborted) void this.#end(stream);
        return stream;
    }

    // Where an emit-only type starts: `null` is the buffer head, a cursor replays the buffer since it, each event at its own position.
    #replay(stream: PushStream, params: StreamEventsRequestParams): Batch {
        const { buffer, report } = this.#deps;
        const { name } = stream.entry;
        const from = params.cursor ?? null;
        if (from === null) {
            const head = buffer.head(name);
            return { cursor: head, truncated: false, events: [], position: head };
        }
        const select = (buffered: BufferedEvent) => selectEvent(stream.entry, stream.ctx, stream.args, buffered, report);
        // `maxEvents: 0` finds where replay starts (after a gap or the `maxAgeMs` floor) without reading an event.
        const start = buffer.read(name, from, { maxEvents: 0, maxAgeMs: params.maxAgeMs, select });
        const events: EventOccurrence[] = [];
        let { cursor: position, hasMore } = start;
        while (hasMore) {
            const read = buffer.read(name, position, { maxEvents: 1, select });
            for (const occurrence of read.events) events.push({ ...occurrence, cursor: read.cursor });
            ({ cursor: position, hasMore } = read);
        }
        return { cursor: events.length === 0 ? position : start.cursor, truncated: start.truncated, events, position };
    }

    #send(stream: PushStream, batch: Batch, active: boolean): void {
        if (active) {
            this.#write(stream, EVENTS_ACTIVE_NOTIFICATION, {
                cursor: batch.cursor,
                truncated: batch.truncated,
                heartbeatMs: stream.grant
            });
        }
        for (const event of batch.events) this.#write(stream, EVENTS_EVENT_NOTIFICATION, event);
        stream.position = batch.position;
    }

    #scheduleCheck(stream: PushStream): void {
        if (!stream.live || stream.entry.kind !== 'check') return;
        stream.checkTimer = unref(setTimeout(() => void this.#check(stream), this.#deps.checkIntervalMs));
    }

    async #check(stream: PushStream): Promise<void> {
        const from = stream.position;
        try {
            const result = await stream.entry.definition.check!(stream.ctx, stream.args, from);
            const batch = await checkedBatch(stream.entry, from, result, undefined, this.#deps.report);
            if (!stream.live) return;
            this.#send(stream, batch, batch.truncated);
        } catch (error) {
            if (!stream.live) return;
            if (error instanceof EventsError && TERMINAL_KINDS.has(error.kind)) {
                void this.#end(stream, error);
                return;
            }
            this.#write(stream, EVENTS_ERROR_NOTIFICATION, { error: errorObject(error) });
        }
        this.#scheduleCheck(stream);
    }

    #write(stream: PushStream, method: string, params: Record<string, unknown>): void {
        const notification = { method, params: { ...params, _meta: { [SUBSCRIPTION_ID_META_KEY]: stream.requestId } } };
        // A failed write means the client is gone.
        stream.queue = stream.queue.then(() => stream.notify(notification)).catch(() => void this.#end(stream));
        if (!stream.live) return;
        clearTimeout(stream.heartbeat);
        stream.heartbeat = unref(
            setTimeout(() => this.#write(stream, EVENTS_HEARTBEAT_NOTIFICATION, { cursor: stream.position }), stream.grant)
        );
    }

    // Ends a stream once. A live one sends `terminated` for an error, runs onUnsubscribe, then lets `open` return.
    #end(stream: PushStream, error?: EventsError): Promise<void> {
        if (!this.#streams.delete(stream)) return Promise.resolve();
        stream.ended.abort();
        clearTimeout(stream.heartbeat);
        clearTimeout(stream.checkTimer);
        if (!stream.live) {
            stream.stopped = error === undefined ? {} : { error };
            return Promise.resolve();
        }
        stream.live = false;
        if (error !== undefined) this.#write(stream, EVENTS_TERMINATED_NOTIFICATION, { error: errorObject(error) });
        return this.#close(stream);
    }

    async #close(stream: PushStream): Promise<void> {
        await this.#unsubscribe(stream);
        await stream.queue;
        stream.finish();
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
