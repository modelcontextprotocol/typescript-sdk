import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/core-internal';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

import type { CheckContext, EventContext, EventResult, PollEventsResult } from '../../../src/ext/events/index';
import { EventsError, EventsExtension } from '../../../src/ext/events/index';
import type { EventsTestHook } from '../../../src/ext/events/testHook';
import type { PostInit, Served } from './harness';
import { errorOf, readFrames, resultOf, serve } from './harness';

const P = z.object({ n: z.number() });
const SUB = 'io.modelcontextprotocol/subscriptionId';
const ACTIVE = 'notifications/events/active';
const EVENT = 'notifications/events/event';
const HEARTBEAT = 'notifications/events/heartbeat';
const ERROR = 'notifications/events/error';
const TERMINATED = 'notifications/events/terminated';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Check = (ctx: CheckContext, args: Record<string, unknown>, cursor: string | null) => EventResult<{ n: number }>;

interface OpenStream {
    id: number;
    response: Response;
    frames: AsyncGenerator<JSONRPCMessage>;
    abort(): void;
}

// Every stream a test opens; afterEach aborts them, as a client going away would.
const opened: AbortController[] = [];
let nextId = 1000;

function testHook(events: EventsExtension): EventsTestHook {
    return (events as unknown as Record<symbol, EventsTestHook>)[Symbol.for('mcp.events.testHook')]!;
}

async function open(served: Served, params: Record<string, unknown>, init: PostInit & { id?: number } = {}): Promise<OpenStream> {
    const id = init.id ?? nextId++;
    const controller = new AbortController();
    opened.push(controller);
    const response = await served.post({ jsonrpc: '2.0', id, method: 'events/stream', params } as JSONRPCRequest, {
        ...init,
        signal: controller.signal
    });
    return { id, response, frames: readFrames(response), abort: () => controller.abort() };
}

async function next(stream: OpenStream): Promise<JSONRPCMessage> {
    const { value, done } = await stream.frames.next();
    if (done) throw new Error('the stream ended');
    return value;
}

// The params of a frame that must be a notification.
function paramsOf(frame: JSONRPCMessage): Record<string, unknown> {
    if (!('method' in frame) || 'id' in frame) throw new Error(`expected a notification, got ${JSON.stringify(frame)}`);
    return frame.params ?? {};
}

// The frames left on a stream the server is ending.
async function rest(stream: OpenStream): Promise<JSONRPCMessage[]> {
    const frames: JSONRPCMessage[] = [];
    for await (const frame of stream.frames) frames.push(frame);
    return frames;
}

function finalResult(id: number) {
    return { jsonrpc: '2.0', id, result: { resultType: 'complete', _meta: expect.objectContaining({ [SUB]: id }) } };
}

function notification(method: string, id: number, params: Record<string, unknown>) {
    return { jsonrpc: '2.0', method, params: { ...params, _meta: expect.objectContaining({ [SUB]: id }) } };
}

afterEach(async () => {
    for (const controller of opened.splice(0)) controller.abort();
    await new Promise(resolve => setImmediate(resolve));
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('events/stream: opening', () => {
    it('sends active first with the default grant and the request id', async () => {
        const events = new EventsExtension();
        events.registerEvent('tick', { payloadSchema: P, check: () => ({ events: [], cursor: 'h0' }) });
        const stream = await open(serve(events), { name: 'tick', cursor: null }, { id: 7 });
        expect(stream.response.headers.get('content-type')).toContain('text/event-stream');
        expect(await next(stream)).toEqual(notification(ACTIVE, 7, { cursor: 'h0', truncated: false, heartbeatMs: 30_000 }));
    });

    it.each([
        [10_000, 10_000],
        [1000, 5000],
        [120_000, 30_000]
    ])('grants %i as %i', async (asked, granted) => {
        const events = new EventsExtension();
        events.registerEvent('tick', { payloadSchema: P, check: () => ({ events: [], cursor: 'h0' }) });
        const stream = await open(serve(events), { name: 'tick', cursor: null, heartbeatMs: asked });
        expect(await next(stream)).toMatchObject({ method: ACTIVE, params: { heartbeatMs: granted } });
    });

    it('answers validation errors at once and opens no stream', async () => {
        const onSubscribe = vi.fn((_ctx: EventContext, args: Record<string, unknown>) => {
            if (args.deny === true) throw new EventsError('forbidden', 'Forbidden', { reason: 'denied' });
        });
        const events = new EventsExtension({ maxSubscriptions: 2 });
        events.registerEvent('i', {
            emitOnly: true,
            inputSchema: z.object({ deny: z.boolean().optional(), a: z.number().optional() }),
            payloadSchema: P,
            onSubscribe
        });
        events.registerEvent('poll-only', { emitOnly: true, payloadSchema: P, delivery: { push: false } });
        const served = serve(events);
        const fail = async (params: Record<string, unknown>) => {
            const response = await served.post({ jsonrpc: '2.0', id: nextId++, method: 'events/stream', params });
            expect(response.headers.get('content-type')).toContain('application/json');
            return ((await response.json()) as { error: unknown }).error;
        };
        expect(await fail({ name: 'missing' })).toMatchObject({ code: -32_023, data: { kind: 'event' } });
        expect(await fail({ name: 'poll-only' })).toMatchObject({ code: -32_026, data: { feature: 'deliveryMode', value: 'push' } });
        expect(await fail({ name: 'i', arguments: { a: 'x' } })).toMatchObject({ code: -32_602 });
        expect(errorOf(await served.rpc('events/stream', { name: 'i' }, { era: 'legacy' }))).toMatchObject({ code: -32_601 });
        expect(await fail({ name: 'i', arguments: { deny: true } })).toMatchObject({ code: -32_024, data: { reason: 'denied' } });
        expect(testHook(events).state().pushStreams).toBe(0);

        // maxSubscriptions counts poll leases and push streams together.
        resultOf(await served.rpc('events/poll', { name: 'i', arguments: { a: 1 } }));
        await next(await open(served, { name: 'i', arguments: { a: 2 } }));
        expect(await fail({ name: 'i', arguments: { a: 3 } })).toMatchObject({ code: -32_025, data: { limit: 'subscriptions', max: 2 } });
        expect(onSubscribe).toHaveBeenCalledTimes(3);
    });

    it('answers a check that fails before active as the request error, after onUnsubscribe', async () => {
        const onUnsubscribe = vi.fn();
        const check = vi
            .fn<Check>()
            .mockImplementationOnce(() => {
                throw new Error('upstream down');
            })
            .mockImplementationOnce(() => {
                throw new EventsError('forbidden', 'Forbidden');
            });
        const events = new EventsExtension();
        events.registerEvent('tick', { payloadSchema: P, check, onUnsubscribe });
        const { rpc } = serve(events);
        expect(errorOf(await rpc('events/stream', { name: 'tick', cursor: null }))).toMatchObject({
            code: -32_603,
            message: 'upstream down'
        });
        expect(errorOf(await rpc('events/stream', { name: 'tick', cursor: 'h1' }))).toMatchObject({ code: -32_024 });
        expect(onUnsubscribe).toHaveBeenCalledTimes(2);
        expect(testHook(events).state().pushStreams).toBe(0);
    });

    it('answers a termination that arrives while the stream starts as the request error', async () => {
        let release!: () => void;
        const onSubscribe = vi.fn(() => new Promise<void>(resolve => (release = resolve)));
        const onUnsubscribe = vi.fn();
        const events = new EventsExtension();
        const handle = events.registerEvent('i', { emitOnly: true, payloadSchema: P, onSubscribe, onUnsubscribe });
        const reply = serve(events).rpc('events/stream', { name: 'i', cursor: null });
        await vi.waitFor(() => expect(onSubscribe).toHaveBeenCalledOnce());
        await handle.terminate(new EventsError('forbidden', 'Forbidden', { reason: 'Access revoked' }));
        expect(onUnsubscribe).not.toHaveBeenCalled();
        release();
        expect(errorOf(await reply)).toEqual({ code: -32_024, message: 'Forbidden', data: { reason: 'Access revoked' } });
        expect(onUnsubscribe).toHaveBeenCalledOnce();
        expect((onUnsubscribe.mock.calls[0]![0] as EventContext).signal.aborted).toBe(true);
    });
});

describe('events/stream: a check type', () => {
    it('sends a heartbeat with the checked cursor after a silent grant', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const check = vi.fn<Check>().mockReturnValueOnce({ events: [], cursor: 'h0' }).mockReturnValue({ events: [], cursor: 'h1' });
        const events = new EventsExtension();
        events.registerEvent('tick', { payloadSchema: P, check });
        const stream = await open(serve(events), { name: 'tick', cursor: null });
        expect(await next(stream)).toMatchObject({ method: ACTIVE, params: { cursor: 'h0' } });
        let heartbeat: JSONRPCMessage | undefined;
        const pending = next(stream).then(frame => (heartbeat = frame));
        await vi.advanceTimersByTimeAsync(29_000);
        expect(heartbeat).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1000);
        expect(await pending).toEqual(notification(HEARTBEAT, stream.id, { cursor: 'h1' }));
        expect(check.mock.calls.slice(1).map(([ctx, , cursor]) => [ctx.mode, cursor])).toEqual([
            ['push', 'h0'],
            ['push', 'h1'],
            ['push', 'h1'],
            ['push', 'h1'],
            ['push', 'h1'],
            ['push', 'h1']
        ]);
    });

    it('replays from a cursor first, then reports a gap mid-stream with a fresh active', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const check = vi
            .fn<Check>()
            .mockReturnValueOnce({
                events: [
                    { eventId: 'a', data: { n: 1 } },
                    { eventId: 'b', data: { n: 2 } }
                ],
                cursor: 'h3'
            })
            .mockReturnValueOnce({
                events: [
                    { eventId: 'c', data: { n: 3 } },
                    { eventId: 'd', data: { n: 4 } }
                ],
                cursor: 'h9',
                truncated: true
            })
            .mockReturnValue({ events: [], cursor: 'h9' });
        const events = new EventsExtension();
        events.registerEvent('tick', { payloadSchema: P, check });
        const stream = await open(serve(events), { name: 'tick', cursor: 'h1' });
        // No cursor runs ahead of an event still to come: a batch's events carry its start cursor until the last.
        expect(await next(stream)).toEqual(notification(ACTIVE, stream.id, { cursor: 'h1', truncated: false, heartbeatMs: 30_000 }));
        expect(await next(stream)).toMatchObject({ method: EVENT, params: { eventId: 'a', name: 'tick', data: { n: 1 }, cursor: 'h1' } });
        expect(await next(stream)).toMatchObject({ method: EVENT, params: { eventId: 'b', data: { n: 2 }, cursor: 'h3' } });
        const gap = next(stream);
        await vi.advanceTimersByTimeAsync(5000);
        // A truncated batch carries the fresh cursor on its active and on every event, so the cursor never moves back.
        expect(await gap).toEqual(notification(ACTIVE, stream.id, { cursor: 'h9', truncated: true, heartbeatMs: 30_000 }));
        expect(await next(stream)).toMatchObject({ method: EVENT, params: { eventId: 'c', cursor: 'h9' } });
        expect(await next(stream)).toMatchObject({ method: EVENT, params: { eventId: 'd', cursor: 'h9' } });
        expect(check.mock.calls.map(call => call[2])).toEqual(['h1', 'h3']);
    });

    it('applies the maxAgeMs floor to the replay and flags truncated', async () => {
        const old = new Date(Date.now() - 600_000).toISOString();
        const check = vi.fn<Check>(() => ({
            events: [
                { eventId: 'old', timestamp: old, data: { n: 1 } },
                { eventId: 'new', data: { n: 2 } },
                { eventId: 'newer', data: { n: 3 } }
            ],
            cursor: 'h2'
        }));
        const events = new EventsExtension();
        events.registerEvent('tick', { payloadSchema: P, check });
        const stream = await open(serve(events), { name: 'tick', cursor: 'h1', maxAgeMs: 300_000 });
        expect(await next(stream)).toMatchObject({ method: ACTIVE, params: { cursor: 'h2', truncated: true } });
        expect(await next(stream)).toMatchObject({ method: EVENT, params: { eventId: 'new', cursor: 'h2' } });
        expect(await next(stream)).toMatchObject({ method: EVENT, params: { eventId: 'newer', cursor: 'h2' } });
        expect(check.mock.calls[0]![0]).toMatchObject({ mode: 'push', maxAgeMs: 300_000 });
    });

    it('keeps the stream open after a transient check error', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const check = vi
            .fn<Check>()
            .mockReturnValueOnce({ events: [], cursor: 'h0' })
            .mockImplementationOnce(() => {
                throw new Error('Gmail API 503');
            })
            .mockReturnValueOnce({ events: [{ eventId: 'e1', data: { n: 1 } }], cursor: 'h1' })
            .mockReturnValue({ events: [], cursor: 'h1' });
        const events = new EventsExtension();
        events.registerEvent('tick', { payloadSchema: P, check });
        const stream = await open(serve(events), { name: 'tick', cursor: null });
        await next(stream);
        const error = next(stream);
        await vi.advanceTimersByTimeAsync(5000);
        expect(await error).toEqual(notification(ERROR, stream.id, { error: { code: -32_603, message: 'Gmail API 503' } }));
        const event = next(stream);
        await vi.advanceTimersByTimeAsync(5000);
        expect(await event).toMatchObject({ method: EVENT, params: { eventId: 'e1', cursor: 'h1', _meta: { [SUB]: stream.id } } });
        expect(check.mock.calls.map(call => call[2])).toEqual([null, 'h0', 'h0']);
    });

    it('terminates when check throws forbidden', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const onUnsubscribe = vi.fn();
        const check = vi
            .fn<Check>()
            .mockReturnValueOnce({ events: [], cursor: 'h0' })
            .mockImplementation(() => {
                throw new EventsError('forbidden', 'Forbidden', { reason: 'Access revoked' });
            });
        const events = new EventsExtension();
        events.registerEvent('tick', { payloadSchema: P, check, onUnsubscribe });
        const stream = await open(serve(events), { name: 'tick', cursor: null });
        await next(stream);
        const remaining = rest(stream);
        await vi.advanceTimersByTimeAsync(5000);
        expect(await remaining).toEqual([
            notification(TERMINATED, stream.id, { error: { code: -32_024, message: 'Forbidden', data: { reason: 'Access revoked' } } }),
            finalResult(stream.id)
        ]);
        expect(onUnsubscribe).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(check).toHaveBeenCalledTimes(2);
    });

    it('stops everything when the client vanishes (Review Focus 1)', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const check = vi.fn<Check>(() => ({ events: [], cursor: 'h0' }));
        const onSubscribe = vi.fn();
        const onUnsubscribe = vi.fn();
        const events = new EventsExtension();
        events.registerEvent('tick', { payloadSchema: P, check, onSubscribe, onUnsubscribe });
        const stream = await open(serve(events), { name: 'tick', cursor: null });
        await next(stream);
        await vi.advanceTimersByTimeAsync(5000);
        expect(check).toHaveBeenCalledTimes(2);
        stream.abort();
        await vi.waitFor(() => expect(onUnsubscribe).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(60_000);
        expect(check).toHaveBeenCalledTimes(2);
        expect(onUnsubscribe).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        expect(testHook(events).state().pushStreams).toBe(0);
        const subscribed = onSubscribe.mock.calls[0]![0] as EventContext;
        const unsubscribed = onUnsubscribe.mock.calls[0]![0] as EventContext;
        expect(subscribed).toMatchObject({ name: 'tick', mode: 'push', principal: null });
        expect(subscribed.subscriptionId).toMatch(UUID);
        expect(unsubscribed.subscriptionId).toBe(subscribed.subscriptionId);
        expect(unsubscribed.signal.aborted).toBe(true);
    });
});

describe('events/stream: an emit-only type', () => {
    it('fans emits out per stream with match, transform and targeted emits', async () => {
        const ids = new Map<string, string>();
        const events = new EventsExtension();
        const handle = events.registerEvent('incident', {
            emitOnly: true,
            inputSchema: z.object({ severity: z.string(), redact: z.boolean().optional() }),
            payloadSchema: z.object({ severity: z.string(), reporter: z.string().nullable() }),
            onSubscribe: (ctx, args) => {
                ids.set(args.severity, ctx.subscriptionId);
            },
            match: (_ctx, event, args) => event.data.severity === args.severity,
            transform: (_ctx, event, args) => (args.redact ? { ...event, data: { ...event.data, reporter: null } } : event)
        });
        const served = serve(events);
        const p1 = await open(served, { name: 'incident', arguments: { severity: 'P1', redact: true }, cursor: null });
        const p3 = await open(served, { name: 'incident', arguments: { severity: 'P3' }, cursor: null });
        const head = paramsOf(await next(p1)).cursor;
        await next(p3);
        await handle.emit({ eventId: 'inc-1', data: { severity: 'P1', reporter: 'ann' } });
        await handle.emit({ eventId: 'inc-3', data: { severity: 'P3', reporter: 'bob' } });
        await handle.emit({ eventId: 'direct', data: { severity: 'P3', reporter: 'cy' } }, { subscriptionId: ids.get('P1')! });
        await handle.emit({ eventId: 'inc-3b', data: { severity: 'P3', reporter: 'dee' } });

        const first = await next(p1);
        expect(first).toEqual(
            notification(EVENT, p1.id, {
                eventId: 'inc-1',
                name: 'incident',
                timestamp: expect.any(String),
                data: { severity: 'P1', reporter: null },
                cursor: expect.any(String)
            })
        );
        expect(paramsOf(first).cursor).not.toBe(head);
        expect(await next(p1)).toMatchObject({ params: { eventId: 'direct', data: { severity: 'P3', reporter: null } } });
        expect(await next(p3)).toMatchObject({ params: { eventId: 'inc-3', data: { reporter: 'bob' }, _meta: { [SUB]: p3.id } } });
        expect(await next(p3)).toMatchObject({ params: { eventId: 'inc-3b' } });
        expect(ids.get('P1')).not.toBe(ids.get('P3'));
    });

    it('replays from a cursor with each event at its own position, then goes live', async () => {
        const events = new EventsExtension();
        const handle = events.registerEvent('i', { emitOnly: true, payloadSchema: P });
        const served = serve(events);
        const poll = async (params: Record<string, unknown>) => resultOf(await served.rpc('events/poll', params)) as PollEventsResult;
        const { cursor: c0 } = await poll({ name: 'i', cursor: null });
        await handle.emit({ eventId: 'e1', data: { n: 1 } });
        await handle.emit({ eventId: 'e2', data: { n: 2 } });
        const { cursor: c1 } = await poll({ name: 'i', cursor: c0, maxEvents: 1 });
        const { cursor: c2 } = await poll({ name: 'i', cursor: c1 });

        const stream = await open(served, { name: 'i', cursor: c0 });
        expect(await next(stream)).toMatchObject({ method: ACTIVE, params: { cursor: c0, truncated: false } });
        expect(await next(stream)).toMatchObject({ method: EVENT, params: { eventId: 'e1', cursor: c1 } });
        expect(await next(stream)).toMatchObject({ method: EVENT, params: { eventId: 'e2', cursor: c2 } });
        await handle.emit({ eventId: 'e3', data: { n: 3 } });
        const live = paramsOf(await next(stream));
        expect(live.eventId).toBe('e3');
        expect([c0, c1, c2]).not.toContain(live.cursor);

        const gap = await open(served, { name: 'i', cursor: 'e00000000.5' });
        expect(await next(gap)).toMatchObject({ method: ACTIVE, params: { cursor: c0, truncated: true } });
        expect(await next(gap)).toMatchObject({ params: { eventId: 'e1', cursor: c1 } });
    });

    it('sends the advanced position on the heartbeat when no event matches', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const events = new EventsExtension({ heartbeatMs: 10_000 });
        const handle = events.registerEvent('i', { emitOnly: true, payloadSchema: P, match: () => false });
        const stream = await open(serve(events), { name: 'i', cursor: null });
        const head = paramsOf(await next(stream)).cursor;
        await handle.emit({ data: { n: 1 } });
        const heartbeat = next(stream);
        await vi.advanceTimersByTimeAsync(10_000);
        const frame = await heartbeat;
        expect(frame).toMatchObject({ method: HEARTBEAT });
        expect(paramsOf(frame).cursor).not.toBe(head);
    });

    it('does not terminate on update()', async () => {
        const events = new EventsExtension();
        const handle = events.registerEvent('i', { emitOnly: true, payloadSchema: P });
        const stream = await open(serve(events), { name: 'i', cursor: null });
        await next(stream);
        handle.update({ description: 'changed' });
        await handle.emit({ eventId: 'after', data: { n: 1 } });
        expect(await next(stream)).toMatchObject({ method: EVENT, params: { eventId: 'after' } });
    });

    it('holds several streams open at once', async () => {
        const events = new EventsExtension();
        const handle = events.registerEvent('i', { emitOnly: true, payloadSchema: P });
        const served = serve(events);
        const streams = await Promise.all([1, 2, 3].map(() => open(served, { name: 'i', cursor: null })));
        for (const stream of streams) await next(stream);
        expect(testHook(events).state().pushStreams).toBe(3);
        await handle.emit({ eventId: 'all', data: { n: 1 } });
        for (const stream of streams) {
            expect(await next(stream)).toMatchObject({ method: EVENT, params: { eventId: 'all', _meta: { [SUB]: stream.id } } });
        }
    });
});

describe('events/stream: termination', () => {
    it('terminates on handle.terminate, remove and a schema change', async () => {
        const onUnsubscribe = vi.fn();
        const events = new EventsExtension();
        const a = events.registerEvent('a', { emitOnly: true, payloadSchema: P, onUnsubscribe });
        const b = events.registerEvent('b', { emitOnly: true, payloadSchema: P, onUnsubscribe });
        events.registerEvent('c', { emitOnly: true, payloadSchema: P, onUnsubscribe });
        const served = serve(events);
        const [sa, sb, sc] = await Promise.all(['a', 'b', 'c'].map(name => open(served, { name, cursor: null })));
        for (const stream of [sa!, sb!, sc!]) await next(stream);

        await a.terminate(new EventsError('forbidden', 'Forbidden', { reason: 'Access revoked' }));
        expect(onUnsubscribe).toHaveBeenCalledOnce();
        b.remove();
        events.registerEvent('c', { emitOnly: true, payloadSchema: z.object({ n: z.string() }) });

        expect(await rest(sa!)).toEqual([
            notification(TERMINATED, sa!.id, { error: { code: -32_024, message: 'Forbidden', data: { reason: 'Access revoked' } } }),
            finalResult(sa!.id)
        ]);
        expect(await rest(sb!)).toEqual([
            notification(TERMINATED, sb!.id, { error: { code: -32_023, message: 'Event type removed', data: { kind: 'event' } } }),
            finalResult(sb!.id)
        ]);
        expect(await rest(sc!)).toEqual([
            notification(TERMINATED, sc!.id, {
                error: {
                    code: -32_026,
                    message: 'Event type payloadSchema changed',
                    data: { feature: 'payloadSchema', reason: 'schema_changed' }
                }
            }),
            finalResult(sc!.id)
        ]);
        expect(onUnsubscribe).toHaveBeenCalledTimes(3);
        expect(testHook(events).state().pushStreams).toBe(0);
    });

    it('terminates only the stream with the given subscriptionId', async () => {
        const ids: string[] = [];
        const events = new EventsExtension();
        const handle = events.registerEvent('i', {
            emitOnly: true,
            payloadSchema: P,
            onSubscribe: ctx => {
                ids.push(ctx.subscriptionId);
            }
        });
        const served = serve(events);
        const first = await open(served, { name: 'i', cursor: null });
        const second = await open(served, { name: 'i', cursor: null });
        await next(first);
        await next(second);
        await handle.terminate(new EventsError('forbidden', 'Forbidden'), { subscriptionId: ids[1]! });
        expect(await rest(second)).toEqual([
            notification(TERMINATED, second.id, { error: { code: -32_024, message: 'Forbidden' } }),
            finalResult(second.id)
        ]);
        await handle.emit({ eventId: 'still', data: { n: 1 } });
        expect(await next(first)).toMatchObject({ params: { eventId: 'still' } });
    });

    it('closes open streams on a simulated restart and fires onUnsubscribe', async () => {
        const onUnsubscribe = vi.fn();
        const events = new EventsExtension();
        events.registerEvent('i', { emitOnly: true, payloadSchema: P, onUnsubscribe });
        const stream = await open(serve(events), { name: 'i', cursor: null });
        await next(stream);
        const hook = testHook(events);
        expect(hook.state()).toEqual({
            trustedOrigins: [],
            emitBuffer: {},
            pollLeases: 0,
            pushStreams: 1,
            webhookSubscriptions: 0,
            webhookExpiryTimers: 0
        });
        hook.restart();
        expect(onUnsubscribe).toHaveBeenCalledOnce();
        expect(await rest(stream)).toEqual([finalResult(stream.id)]);
        expect(hook.state().pushStreams).toBe(0);
    });
});

describe('events/stream: response modes', () => {
    it("streams under responseMode: 'json' (Decision 11)", async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const events = new EventsExtension();
        events.registerEvent('tick', { payloadSchema: P, check: () => ({ events: [], cursor: 'h0' }) });
        const served = serve(events, {
            responseMode: 'json',
            setup: mcp =>
                mcp.registerTool('progress', { inputSchema: z.object({}) }, async (_args, ctx) => {
                    await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: 'tok', progress: 1 } });
                    return { content: [{ type: 'text', text: 'done' }] };
                })
        });
        expect(warn).toHaveBeenCalledWith(
            "responseMode: 'json' drops mid-call notifications. subscriptions/listen and events/stream are always streamed regardless; " +
                'other notifications emitted before a result are dropped.'
        );

        const stream = await open(served, { name: 'tick', cursor: null });
        expect(stream.response.headers.get('content-type')).toContain('text/event-stream');
        expect(await next(stream)).toMatchObject({ method: ACTIVE, params: { cursor: 'h0' } });

        const missing = await served.post({ jsonrpc: '2.0', id: 1, method: 'events/stream', params: { name: 'missing' } });
        expect(missing.headers.get('content-type')).toContain('application/json');
        expect(await missing.json()).toMatchObject({ id: 1, error: { code: -32_023 } });

        const tool = await served.post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'progress', arguments: {} } });
        expect(tool.headers.get('content-type')).toContain('application/json');
        const text = await tool.text();
        expect(text).not.toContain('notifications/progress');
        expect(JSON.parse(text)).toMatchObject({ id: 2, result: { content: [{ type: 'text', text: 'done' }] } });
    });

    it('sends no SSE comment keepalive on events/stream, while another SSE exchange still gets one (SEP-3415 §Push)', async () => {
        const events = new EventsExtension();
        events.registerEvent('tick', { payloadSchema: P, check: () => ({ events: [], cursor: 'h0' }) });
        const served = serve(events, {
            keepAliveMs: 20,
            setup: mcp =>
                mcp.registerTool('slow', { inputSchema: z.object({}) }, async (_args, ctx) => {
                    await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: 'tok', progress: 1 } });
                    await new Promise(resolve => setTimeout(resolve, 150));
                    return { content: [{ type: 'text', text: 'done' }] };
                })
        });

        const stream = await open(served, { name: 'tick', cursor: null });
        expect(stream.response.headers.get('content-type')).toContain('text/event-stream');
        const streamed = await rawFor(stream.response, 150);
        expect(streamed).toContain(ACTIVE);
        expect(streamed).not.toMatch(/^:/m);

        const tool = await served.post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'slow', arguments: {} } });
        expect(tool.headers.get('content-type')).toContain('text/event-stream');
        expect(await tool.text()).toMatch(/^: keepalive$/m);
    });
});

// The raw SSE text a response delivers within `ms`, comment lines included.
async function rawFor(response: Response, ms: number): Promise<string> {
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    const timer = setTimeout(() => void reader.cancel(), ms);
    let text = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return text;
            text += value;
        }
    } finally {
        clearTimeout(timer);
    }
}
