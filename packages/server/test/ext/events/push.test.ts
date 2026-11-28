import { PassThrough, Writable } from 'node:stream';

import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/core-internal';
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/core-internal';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

import type { CheckContext, EventContext, EventResult, PollEventsResult } from '../../../src/ext/events/index';
import { EventsError, EventsExtension } from '../../../src/ext/events/index';
import type { EventsTestHook } from '../../../src/ext/events/testHook';
import { McpServer } from '../../../src/server/mcp';
import { serveStdio } from '../../../src/server/serveStdio';
import { StdioServerTransport } from '../../../src/server/stdio';
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

        // maxSubscriptions counts poll leases and push streams together; without getPrincipal no per-principal share applies.
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

    it.each(['onSubscribe', 'the first check'])(
        'answers a termination during %s that honours ctx.signal with the termination, not the abort it causes',
        async during => {
            let started = false;
            const untilAborted = (ctx: EventContext) =>
                new Promise<never>((_, reject) => {
                    started = true;
                    ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
                });
            const events = new EventsExtension();
            const handle = events.registerEvent('t', {
                payloadSchema: P,
                ...(during === 'onSubscribe' && { onSubscribe: untilAborted }),
                check: async ctx => (during === 'the first check' ? untilAborted(ctx) : { events: [], cursor: 'c1' })
            });
            const reply = serve(events).rpc('events/stream', { name: 't', cursor: 'c0' });
            await vi.waitFor(() => expect(started).toBe(true));
            await handle.terminate(new EventsError('forbidden', 'Forbidden', { reason: 'Access revoked' }));
            expect(errorOf(await reply)).toEqual({ code: -32_024, message: 'Forbidden', data: { reason: 'Access revoked' } });
        }
    );
});

describe('events/stream: a check type', () => {
    it('keeps a heartbeatMs and checkIntervalMs beyond the longest timer from firing every millisecond', async () => {
        const check = vi.fn(() => ({ events: [], cursor: 'h0' }));
        const events = new EventsExtension({ heartbeatMs: 2 ** 32, checkIntervalMs: 2 ** 32 });
        events.registerEvent('tick', { payloadSchema: P, check });
        const stream = await open(serve(events), { name: 'tick', cursor: null });
        const streamed = await rawFor(stream.response, 100);
        expect(streamed).toContain(ACTIVE);
        expect(streamed).toContain(`"heartbeatMs":${2 ** 32}`);
        expect(streamed).not.toContain(HEARTBEAT);
        expect(check).toHaveBeenCalledOnce();
    });

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

    it('replays from a cursor first, then reports a gap mid-stream with another active', async () => {
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
        // A truncated batch's cursors stay at its start too, on its active and its events until the last.
        expect(await gap).toEqual(notification(ACTIVE, stream.id, { cursor: 'h3', truncated: true, heartbeatMs: 30_000 }));
        expect(await next(stream)).toMatchObject({ method: EVENT, params: { eventId: 'c', cursor: 'h3' } });
        expect(await next(stream)).toMatchObject({ method: EVENT, params: { eventId: 'd', cursor: 'h9' } });
        expect(check.mock.calls.map(call => call[2])).toEqual(['h1', 'h3']);
    });

    it('resumes a truncated batch dropped after its first event from that event, and delivers the rest', async () => {
        const batch = {
            events: [
                { eventId: 'a', data: { n: 1 } },
                { eventId: 'b', data: { n: 2 } },
                { eventId: 'c', data: { n: 3 } }
            ],
            cursor: 'h9',
            truncated: true
        };
        const check = vi.fn<Check>((_ctx, _args, cursor) => (cursor === 'h1' ? batch : { events: [], cursor: 'h9' }));
        const events = new EventsExtension();
        events.registerEvent('tick', { payloadSchema: P, check });
        const served = serve(events);
        const first = await open(served, { name: 'tick', cursor: 'h1' });
        expect(await next(first)).toMatchObject({ method: ACTIVE, params: { cursor: 'h1', truncated: true } });
        const dropped = paramsOf(await next(first));
        expect(dropped).toMatchObject({ eventId: 'a', cursor: 'h1' });
        first.abort();

        const resumed = await open(served, { name: 'tick', cursor: dropped['cursor'] });
        expect(await next(resumed)).toMatchObject({ method: ACTIVE, params: { cursor: 'h1', truncated: true } });
        const frames = [paramsOf(await next(resumed)), paramsOf(await next(resumed)), paramsOf(await next(resumed))];
        expect(frames.map(params => [params['eventId'], params['cursor']])).toEqual([
            ['a', 'h1'],
            ['b', 'h1'],
            ['c', 'h9']
        ]);
    });

    it('confirms a cursor: null result with truncated: false, and sends no fresh active for its gaps (SEP-3415 §Cursor Lifecycle)', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const check = vi.fn<Check>(() => ({ events: [], cursor: null, truncated: true }));
        const events = new EventsExtension({ heartbeatMs: 10_000 });
        events.registerEvent('tick', { payloadSchema: P, check });
        const stream = await open(serve(events), { name: 'tick', cursor: 'h1' });
        expect(await next(stream)).toEqual(notification(ACTIVE, stream.id, { cursor: null, truncated: false, heartbeatMs: 10_000 }));
        const frame = next(stream);
        await vi.advanceTimersByTimeAsync(10_000);
        // The check at 5 s reported a gap and sent nothing, so the next frame is the heartbeat.
        expect(await frame).toEqual(notification(HEARTBEAT, stream.id, { cursor: null }));
        expect(check.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('applies the maxAgeMs floor to the replay and flags truncated', async () => {
        // The clock stands still, so the floor the request fixes is exactly maxAgeMs back when the replay runs.
        vi.useFakeTimers({ toFake: ['Date'] });
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
        expect(await next(stream)).toMatchObject({ method: ACTIVE, params: { cursor: 'h1', truncated: true } });
        expect(await next(stream)).toMatchObject({ method: EVENT, params: { eventId: 'new', cursor: 'h1' } });
        expect(await next(stream)).toMatchObject({ method: EVENT, params: { eventId: 'newer', cursor: 'h2' } });
        expect(check.mock.calls[0]![0]).toMatchObject({ mode: 'push', maxAgeMs: 300_000 });
    });

    it('applies the maxAgeMs floor of the request to every later check run, as the replay pages through the upstream', async () => {
        // The clock moves only when the test moves it; setImmediate stays real for afterEach.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const old = new Date(Date.now() - 600_000).toISOString();
        const check = vi
            .fn<Check>()
            .mockReturnValueOnce({ events: [{ eventId: 'p1', data: { n: 1 } }], cursor: 'h1', hasMore: true })
            .mockReturnValueOnce({
                events: [
                    { eventId: 'old', timestamp: old, data: { n: 2 } },
                    { eventId: 'p2', data: { n: 3 } }
                ],
                cursor: 'h2'
            })
            .mockReturnValue({ events: [], cursor: 'h2' });
        const events = new EventsExtension();
        events.registerEvent('tick', { payloadSchema: P, check });
        const stream = await open(serve(events), { name: 'tick', cursor: 'h0', maxAgeMs: 300_000 });
        expect(await next(stream)).toMatchObject({ method: ACTIVE, params: { cursor: 'h0', truncated: false } });
        expect(await next(stream)).toMatchObject({ method: EVENT, params: { eventId: 'p1', cursor: 'h1' } });
        // The page left more waiting, so the next check runs at once; the one after waits the interval.
        await vi.advanceTimersByTimeAsync(0);
        expect(await next(stream)).toMatchObject({ method: ACTIVE, params: { cursor: 'h1', truncated: true } });
        expect(await next(stream)).toMatchObject({ method: EVENT, params: { eventId: 'p2', cursor: 'h2' } });
        await vi.advanceTimersByTimeAsync(5000);
        expect(check.mock.calls.map(([ctx, , cursor]) => [cursor, ctx.maxAgeMs])).toEqual([
            ['h0', 300_000],
            ['h1', 300_000],
            ['h2', 305_000]
        ]);
    });

    it('drops a check event without an eventId and reports it', async () => {
        const onerror = vi.fn();
        // As plain JavaScript returns it, past the type that requires eventId.
        const unidentified = { data: { n: 1 } } as { eventId: string; data: { n: number } };
        const check = vi.fn<Check>(() => ({ events: [unidentified, { eventId: 'kept', data: { n: 2 } }], cursor: 'h2' }));
        const events = new EventsExtension({ onerror });
        events.registerEvent('tick', { payloadSchema: P, check });
        const stream = await open(serve(events), { name: 'tick', cursor: 'h1' });
        expect(await next(stream)).toMatchObject({ method: ACTIVE, params: { cursor: 'h1', truncated: false } });
        expect(await next(stream)).toMatchObject({ method: EVENT, params: { eventId: 'kept', data: { n: 2 }, cursor: 'h2' } });
        expect(onerror).toHaveBeenCalledOnce();
        expect(onerror).toHaveBeenCalledWith(
            expect.objectContaining({ message: "event 'tick': dropped an event from check without an eventId" })
        );
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

    it('parses the next batch of an open stream with the payloadSchema of an update()', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const labelled = (eventId: string, n: number) => ({ eventId, data: { n, label: `#${n}` } as { n: number } });
        const check = vi
            .fn<Check>()
            .mockReturnValueOnce({ events: [], cursor: 'h0' })
            .mockReturnValueOnce({ events: [labelled('e1', 1)], cursor: 'h1' })
            .mockReturnValueOnce({ events: [labelled('e2', 2)], cursor: 'h2' })
            .mockReturnValue({ events: [], cursor: 'h2' });
        const events = new EventsExtension();
        const handle = events.registerEvent('tick', { payloadSchema: P, check });
        const stream = await open(serve(events), { name: 'tick', cursor: null });
        await next(stream);
        const before = next(stream);
        await vi.advanceTimersByTimeAsync(5000);
        // The registered schema strips the unknown `label`.
        expect(await before).toMatchObject({ method: EVENT, params: { eventId: 'e1' } });
        expect(paramsOf(await before)['data']).toEqual({ n: 1 });

        handle.update({ payloadSchema: z.object({ n: z.number(), label: z.string().optional() }) });
        const after = next(stream);
        await vi.advanceTimersByTimeAsync(5000);
        expect(paramsOf(await after)['data']).toEqual({ n: 2, label: '#2' });
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

    it('stops everything when the client vanishes', async () => {
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
    it('fans emits out per stream with match and transform', async () => {
        const ids = new Map<string, string>();
        const events = new EventsExtension();
        const handle = events.registerEvent('incident', {
            emitOnly: true,
            inputSchema: z.object({ severity: z.string(), redact: z.boolean().optional() }),
            payloadSchema: z.object({ severity: z.string(), reporter: z.string().nullable() }),
            onSubscribe: (ctx, args) => {
                ids.set(args.severity, ctx.subscriptionId);
            },
            match: (_ctx, event, args) => event.data.severity === args.severity || event.data.reporter === 'all',
            transform: (_ctx, event, args) => (args.redact ? { ...event, data: { ...event.data, reporter: null } } : event)
        });
        const served = serve(events);
        const p1 = await open(served, { name: 'incident', arguments: { severity: 'P1', redact: true }, cursor: null });
        const p3 = await open(served, { name: 'incident', arguments: { severity: 'P3' }, cursor: null });
        const head = paramsOf(await next(p1)).cursor;
        await next(p3);
        await handle.emit({ eventId: 'inc-1', data: { severity: 'P1', reporter: 'ann' } });
        await handle.emit({ eventId: 'inc-3', data: { severity: 'P3', reporter: 'bob' } });
        await handle.emit({ eventId: 'both', data: { severity: 'P2', reporter: 'all' } });
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
        expect(await next(p1)).toMatchObject({ params: { eventId: 'both', data: { severity: 'P2', reporter: null } } });
        expect(await next(p3)).toMatchObject({ params: { eventId: 'inc-3', data: { reporter: 'bob' }, _meta: { [SUB]: p3.id } } });
        expect(await next(p3)).toMatchObject({ params: { eventId: 'both', data: { reporter: 'all' } } });
        expect(await next(p3)).toMatchObject({ params: { eventId: 'inc-3b' } });
        expect(ids.get('P1')).not.toBe(ids.get('P3'));
    });

    it('drops a transform output that fails payloadSchema, replayed or live, and reports it', async () => {
        const onerror = vi.fn();
        const events = new EventsExtension({ onerror });
        const handle = events.registerEvent('i', {
            emitOnly: true,
            payloadSchema: P,
            transform: (_ctx, event) =>
                event.eventId?.startsWith('bad') === true ? { ...event, data: { n: 'x' } as unknown as { n: number } } : event
        });
        const served = serve(events);
        const { cursor } = resultOf(await served.rpc('events/poll', { name: 'i', cursor: null })) as PollEventsResult;
        await handle.emit({ eventId: 'bad-1', data: { n: 1 } });
        await handle.emit({ eventId: 'good-2', data: { n: 2 } });
        const stream = await open(served, { name: 'i', cursor });
        expect(await next(stream)).toMatchObject({ method: ACTIVE });
        expect(await next(stream)).toMatchObject({ method: EVENT, params: { eventId: 'good-2', data: { n: 2 } } });
        await handle.emit({ eventId: 'bad-3', data: { n: 3 } });
        await handle.emit({ eventId: 'good-4', data: { n: 4 } });
        expect(await next(stream)).toMatchObject({ method: EVENT, params: { eventId: 'good-4' } });
        expect(onerror).toHaveBeenCalledTimes(2);
    });

    it('drops and reports an event JSON cannot carry, and keeps the stream open for the events after it', async () => {
        const onerror = vi.fn();
        const events = new EventsExtension({ onerror });
        const handle = events.registerEvent('i', {
            emitOnly: true,
            payloadSchema: P,
            transform: (_ctx, event) => (event.eventId === 'shaped' ? { ...event, _meta: { big: 2n } } : event)
        });
        const stream = await open(serve(events), { name: 'i', cursor: null });
        expect(await next(stream)).toMatchObject({ method: ACTIVE });
        await handle.emit({ eventId: 'meta', data: { n: 1 }, _meta: { big: 1n } });
        await handle.emit({ eventId: 'shaped', data: { n: 2 } });
        await handle.emit({ eventId: 'after', data: { n: 3 } });
        expect(await next(stream)).toMatchObject({ method: EVENT, params: { eventId: 'after' } });
        expect(testHook(events).state().pushStreams).toBe(1);
        expect(onerror.mock.calls.map(([error]) => (error as Error).message)).toEqual([
            expect.stringMatching(/^event 'i': dropped an event that cannot be serialised to JSON: /),
            expect.stringMatching(/^event 'i': dropped an event that cannot be serialised to JSON: /)
        ]);
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

    it('keeps the heartbeat at the grant while a transform whose output fails payloadSchema drops every event', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const events = new EventsExtension({ onerror: () => {} });
        const handle = events.registerEvent('i', {
            emitOnly: true,
            payloadSchema: P,
            transform: (_ctx, event) => ({ ...event, data: { n: 'x' } as unknown as { n: number } })
        });
        const stream = await open(serve(events), { name: 'i', cursor: null, heartbeatMs: 5000 });
        expect(await next(stream)).toMatchObject({ method: ACTIVE });

        const methods: string[] = [];
        void (async () => {
            for await (const frame of stream.frames) if ('method' in frame) methods.push(frame.method);
        })().catch(() => {});
        // An event a second for 10 s, each dropped: the heartbeats still come every 5 s.
        for (let second = 1; second <= 10; second++) {
            await handle.emit({ data: { n: second } });
            await vi.advanceTimersByTimeAsync(1000);
        }
        expect(methods).toEqual([HEARTBEAT, HEARTBEAT]);
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

    it("frees a stream's place in its principal's share when it ends, by termination, by the client or by a refused start", async () => {
        let refuse = false;
        const events = new EventsExtension({ maxSubscriptions: 4, getPrincipal: () => 'alice' });
        const handle = events.registerEvent('i', {
            emitOnly: true,
            payloadSchema: P,
            onSubscribe: () => {
                if (refuse) throw new EventsError('forbidden', 'Forbidden');
            }
        });
        const served = serve(events);
        const share = { code: -32_025, data: { limit: 'principalSubscriptions', max: 1 } };
        const refusal = async () => errorOf(await served.rpc('events/stream', { name: 'i', cursor: null }));

        const first = await open(served, { name: 'i', cursor: null });
        await next(first);
        expect(await refusal()).toMatchObject(share);
        await handle.terminate(new EventsError('forbidden', 'Forbidden'));
        await rest(first);

        const second = await open(served, { name: 'i', cursor: null });
        await next(second);
        expect(await refusal()).toMatchObject(share);
        second.abort();
        await vi.waitFor(() => expect(testHook(events).state().pushStreams).toBe(0));

        refuse = true;
        expect(await refusal()).toMatchObject({ code: -32_024 });
        refuse = false;
        await next(await open(served, { name: 'i', cursor: null }));
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

describe('events/stream: a client that stops reading', () => {
    const BIG = z.object({ s: z.string() });
    const big = (n: number) => ({ eventId: `e${n}`, data: { s: 'x'.repeat(100_000) } });

    it('abandons a stream whose client leaves more than 1 MiB unread for a whole grant: its unread bytes go with the errored response, and the subscription ends', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const onUnsubscribe = vi.fn();
        const events = new EventsExtension();
        const handle = events.registerEvent('big', { emitOnly: true, payloadSchema: BIG, onUnsubscribe });
        const served = serve(events);
        const stalled = await open(served, { name: 'big', cursor: null, heartbeatMs: 5000 });
        const reading = await open(served, { name: 'big', cursor: null, heartbeatMs: 5000 });
        expect(await next(stalled)).toMatchObject({ method: ACTIVE });
        expect(await next(reading)).toMatchObject({ method: ACTIVE });

        // 20 events of 100 kB: the reading client gets them all, while the stalled stream holds what passed the bound and waits.
        const read: unknown[] = [];
        for (let n = 0; n < 20; n++) {
            await handle.emit(big(n));
            read.push(paramsOf(await next(reading))['eventId']);
        }
        expect(read).toHaveLength(20);
        await vi.advanceTimersByTimeAsync(4000);
        expect(testHook(events).state().pushStreams).toBe(2);
        expect(onUnsubscribe).not.toHaveBeenCalled();

        // A grant after it went over the bound, the stalled stream is abandoned, and the one that reads gets its heartbeat.
        const heartbeat = next(reading);
        await vi.advanceTimersByTimeAsync(1000);
        expect(await heartbeat).toMatchObject({ method: HEARTBEAT });
        expect(testHook(events).state().pushStreams).toBe(1);
        expect(onUnsubscribe).toHaveBeenCalledOnce();
        await expect(rest(stalled)).rejects.toThrow();
    });

    it('abandons an emit-only stream whose client reads about a frame per grant while emits outpace it, once more events wait than the buffer holds', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const onUnsubscribe = vi.fn();
        const events = new EventsExtension({ emitBuffer: { maxEvents: 10 } });
        const handle = events.registerEvent('big', { emitOnly: true, payloadSchema: BIG, onUnsubscribe });
        const stream = await open(serve(events), { name: 'big', cursor: null, heartbeatMs: 5000 });
        expect(await next(stream)).toMatchObject({ method: ACTIVE });

        // Two events a second; the client reads one frame every 4 s, so the backlog never stays over the bound for a grant.
        for (let second = 0; second < 40 && testHook(events).state().pushStreams === 1; second++) {
            await handle.emit(big(2 * second));
            await handle.emit(big(2 * second + 1));
            if (second % 4 === 3) await next(stream);
            await vi.advanceTimersByTimeAsync(1000);
        }
        expect(testHook(events).state().pushStreams).toBe(0);
        expect(onUnsubscribe).toHaveBeenCalledOnce();
        await expect(rest(stream)).rejects.toThrow();
        // The frames that waited are gone with it: nothing waits on a timer any more.
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('delivers a burst of more emits than the buffer holds, started at once, in full to a client that reads', async () => {
        const onUnsubscribe = vi.fn();
        const events = new EventsExtension({ emitBuffer: { maxEvents: 10 } });
        const handle = events.registerEvent('n', { emitOnly: true, payloadSchema: P, onUnsubscribe });
        const stream = await open(serve(events), { name: 'n', cursor: null });
        expect(await next(stream)).toMatchObject({ method: ACTIVE });

        await Promise.all(Array.from({ length: 25 }, (_, n) => handle.emit({ eventId: `e${n}`, data: { n } })));
        const read: unknown[] = [];
        for (let n = 0; n < 25; n++) read.push(paramsOf(await next(stream))['eventId']);
        expect(read).toEqual(Array.from({ length: 25 }, (_, n) => `e${n}`));
        expect(testHook(events).state().pushStreams).toBe(1);
        expect(onUnsubscribe).not.toHaveBeenCalled();
    });

    it('pages a check stream by ctx.maxEvents 100, and follows a page with more waiting at once', async () => {
        const upstream = Array.from({ length: 250 }, (_, n) => ({ eventId: `u${n}`, data: { n } }));
        const check = vi.fn((ctx: CheckContext, _args: unknown, cursor: string | null) => {
            if (cursor === null) return { events: [], cursor: '0' };
            const from = Number(cursor);
            const to = Math.min(upstream.length, from + (ctx.maxEvents ?? upstream.length));
            return { events: upstream.slice(from, to), cursor: String(to), hasMore: to < upstream.length };
        });
        const events = new EventsExtension();
        events.registerEvent('t', { payloadSchema: P, check });
        const stream = await open(serve(events), { name: 't', cursor: '0' });
        expect(await next(stream)).toMatchObject({ method: ACTIVE, params: { cursor: '0' } });

        // Well within the 5 s check interval: the pages after the first follow at once.
        const read: unknown[] = [];
        for (let n = 0; n < 250; n++) read.push(paramsOf(await next(stream))['eventId']);
        expect(read).toEqual(upstream.map(event => event.eventId));
        expect(check.mock.calls.map(([ctx, , cursor]) => [cursor, ctx.maxEvents])).toEqual([
            ['0', 100],
            ['100', 100],
            ['200', 100]
        ]);
    });

    it('sends one truncated active for a maxAgeMs catch-up over many pages of old events, and another for a later, separate gap', async () => {
        const old = new Date(Date.now() - 7 * 86_400_000).toISOString();
        // 1 000 week-old entries, then a fresh one; `lose` makes the next run report lost upstream history.
        const upstream = [
            ...Array.from({ length: 1000 }, (_, n) => ({ eventId: `old${n}`, timestamp: old, data: { n } })),
            { eventId: 'fresh', data: { n: 1000 } }
        ];
        let lose = false;
        const check = (ctx: CheckContext, _args: unknown, cursor: string | null) => {
            if (lose) {
                lose = false;
                return { events: [], cursor: String(upstream.length), truncated: true };
            }
            const from = cursor === null ? upstream.length : Number(cursor);
            const to = Math.min(upstream.length, from + (ctx.maxEvents ?? upstream.length));
            return { events: upstream.slice(from, to), cursor: String(to), hasMore: to < upstream.length };
        };
        const events = new EventsExtension({ checkIntervalMs: 100 });
        events.registerEvent('t', { payloadSchema: P, check });
        const stream = await open(serve(events), { name: 't', cursor: '0', maxAgeMs: 300_000 });

        // The start page told of the truncation; the nine pages after it that the floor empties tell nothing more.
        expect(await next(stream)).toMatchObject({ method: ACTIVE, params: { truncated: true } });
        expect(await next(stream)).toMatchObject({ method: EVENT, params: { eventId: 'fresh', cursor: '1001' } });
        lose = true;
        expect(await next(stream)).toMatchObject({ method: ACTIVE, params: { cursor: '1001', truncated: true } });
    });

    it('runs the next page of a check stream only once its client has taken the last one', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const check = vi.fn((_ctx: CheckContext, _args: unknown, cursor: string | null) =>
            cursor === null
                ? { events: [], cursor: '0' }
                : {
                      events: Array.from({ length: 20 }, (_, n) => ({ ...big(n), eventId: `${cursor}.${n}` })),
                      cursor: `${Number(cursor) + 1}`,
                      hasMore: true
                  }
        );
        const events = new EventsExtension();
        events.registerEvent('t', { payloadSchema: BIG, check });
        const stream = await open(serve(events), { name: 't', cursor: '0', heartbeatMs: 5000 });
        expect(await next(stream)).toMatchObject({ method: ACTIVE });

        // The 2 MB start page waits for the client, so no other page is read meanwhile.
        await vi.advanceTimersByTimeAsync(4000);
        expect(check).toHaveBeenCalledOnce();
        for (let n = 0; n < 20; n++) expect(await next(stream)).toMatchObject({ params: { eventId: `0.${n}` } });
        await vi.advanceTimersByTimeAsync(0);
        expect(check).toHaveBeenCalledTimes(2);
    });

    it("runs a check stream's next check only once its client has taken the last batch", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const check = vi.fn((_ctx: CheckContext, _args: unknown, cursor: string | null) =>
            cursor === null
                ? { events: [], cursor: '0' }
                : {
                      events: Array.from({ length: 20 }, (_, n) => big(n)).map((event, n) => ({ ...event, eventId: `${cursor}.${n}` })),
                      cursor: `${Number(cursor) + 1}`
                  }
        );
        const events = new EventsExtension({ checkIntervalMs: 1000 });
        events.registerEvent('t', { payloadSchema: BIG, check });
        const stream = await open(serve(events), { name: 't', cursor: null, heartbeatMs: 5000 });
        expect(await next(stream)).toMatchObject({ method: ACTIVE });

        // The 2 MB batch of the first run waits for the client, so no other run starts meanwhile.
        await vi.advanceTimersByTimeAsync(4000);
        expect(check).toHaveBeenCalledTimes(2);
        for (let n = 0; n < 20; n++) expect(await next(stream)).toMatchObject({ params: { eventId: `0.${n}` } });
        await vi.advanceTimersByTimeAsync(1000);
        expect(check).toHaveBeenCalledTimes(3);
    });

    it('abandons at once a stream that ends while its client is over the bound, so terminate() does not wait for room', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const events = new EventsExtension();
        const handle = events.registerEvent('big', { emitOnly: true, payloadSchema: BIG });
        const stream = await open(serve(events), { name: 'big', cursor: null, heartbeatMs: 5000 });
        expect(await next(stream)).toMatchObject({ method: ACTIVE });
        for (let n = 0; n < 20; n++) await handle.emit(big(n));

        let ended = false;
        void handle.terminate(new EventsError('forbidden', 'Forbidden')).then(() => (ended = true));
        await vi.advanceTimersByTimeAsync(10);
        expect(ended).toBe(true);
        expect(testHook(events).state().pushStreams).toBe(0);
        // No `terminated` frame: the response is cut off with its unread bytes.
        await expect(rest(stream)).rejects.toThrow();
    });

    it('terminates at once a stream whose client is just under the bound with frames still queued, abandoning it as the last ones put it over', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const events = new EventsExtension();
        const handle = events.registerEvent('big', { emitOnly: true, payloadSchema: BIG });
        const stream = await open(serve(events), { name: 'big', cursor: null, heartbeatMs: 5000 });
        expect(await next(stream)).toMatchObject({ method: ACTIVE });
        for (let n = 0; n < 30; n++) await handle.emit(big(n));
        // The client reads four frames: now under 1 MiB unread, with frames still queued behind the one that waits for room.
        for (let n = 0; n < 4; n++) await next(stream);

        let ended = false;
        void handle.terminate(new EventsError('forbidden', 'Forbidden')).then(() => (ended = true));
        await vi.advanceTimersByTimeAsync(10);
        expect(ended).toBe(true);
        expect(testHook(events).state().pushStreams).toBe(0);
        // The queued events go out ahead of `terminated` until they put the client over the bound, which abandons the stream.
        await expect(rest(stream)).rejects.toThrow();
    });

    it('delivers the events emitted just before terminate() ahead of terminated to a client that reads', async () => {
        const events = new EventsExtension();
        const handle = events.registerEvent('n', { emitOnly: true, payloadSchema: P });
        const stream = await open(serve(events), { name: 'n', cursor: null });
        expect(await next(stream)).toMatchObject({ method: ACTIVE });

        await Promise.all(Array.from({ length: 5 }, (_, n) => handle.emit({ eventId: `e${n}`, data: { n } })));
        await handle.terminate(new EventsError('forbidden', 'Forbidden'));
        const frames = await rest(stream);
        expect(frames.slice(0, -2).map(frame => paramsOf(frame)['eventId'])).toEqual(['e0', 'e1', 'e2', 'e3', 'e4']);
        expect(frames.slice(-2)).toEqual([
            notification(TERMINATED, stream.id, { error: { code: -32_024, message: 'Forbidden' } }),
            finalResult(stream.id)
        ]);
    });

    it('counts only live events against the cap, so a client that falls fewer than maxEvents behind after a full replay stays', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const events = new EventsExtension({ emitBuffer: { maxEvents: 10 } });
        const handle = events.registerEvent('big', { emitOnly: true, payloadSchema: BIG });
        const served = serve(events);
        const { cursor: start } = resultOf(await served.rpc('events/poll', { name: 'big', cursor: null })) as PollEventsResult;
        // A full buffer of 300 kB events: the response takes four, and the rest of the replay waits.
        const huge = (n: number) => ({ eventId: `e${n}`, data: { s: 'x'.repeat(300_000) } });
        for (let n = 0; n < 10; n++) await handle.emit(huge(n));
        const stream = await open(served, { name: 'big', cursor: start, heartbeatMs: 5000 });
        expect(await next(stream)).toMatchObject({ method: ACTIVE });
        for (let n = 10; n < 18; n++) await handle.emit(huge(n));
        expect(testHook(events).state().pushStreams).toBe(1);

        const read: unknown[] = [];
        for (let n = 0; n < 18; n++) read.push(paramsOf(await next(stream))['eventId']);
        expect(read).toEqual(Array.from({ length: 18 }, (_, n) => `e${n}`));
        expect(testHook(events).state().pushStreams).toBe(1);
    });

    it('frees the place of an abandoned stream in maxSubscriptions only as its response is dropped', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const events = new EventsExtension({ maxSubscriptions: 1 });
        const handle = events.registerEvent('big', { emitOnly: true, payloadSchema: BIG });
        const served = serve(events);
        const refusal = async () => errorOf(await served.rpc('events/stream', { name: 'big', cursor: null }));
        const stalled = await open(served, { name: 'big', cursor: null, heartbeatMs: 5000 });
        expect(await next(stalled)).toMatchObject({ method: ACTIVE });
        for (let n = 0; n < 20; n++) await handle.emit(big(n));

        await vi.advanceTimersByTimeAsync(4000);
        expect(await refusal()).toMatchObject({ code: -32_025, data: { limit: 'subscriptions' } });
        await vi.advanceTimersByTimeAsync(1000);
        await expect(rest(stalled)).rejects.toThrow();
        expect(testHook(events).state().pushStreams).toBe(0);
        expect(await next(await open(served, { name: 'big', cursor: null }))).toMatchObject({ method: ACTIVE });
    });

    it('delivers a replay of more than 1 MiB in full at the pace its client reads, and keeps the stream open', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const events = new EventsExtension();
        const handle = events.registerEvent('big', { emitOnly: true, payloadSchema: BIG });
        const served = serve(events);
        const { cursor: start } = resultOf(await served.rpc('events/poll', { name: 'big', cursor: null })) as PollEventsResult;
        // 10 MB buffered before the stream opens, then one live event behind the replay.
        for (let n = 0; n < 100; n++) await handle.emit(big(n));
        const stream = await open(served, { name: 'big', cursor: start, heartbeatMs: 5000 });
        expect(await next(stream)).toMatchObject({ method: ACTIVE });
        await handle.emit(big(100));

        // The client reads 15 events, then pauses for less than a grant, again and again, for several grants.
        const read: unknown[] = [];
        while (read.length < 101) {
            for (let n = 0; n < 15 && read.length < 101; n++) read.push(paramsOf(await next(stream))['eventId']);
            await vi.advanceTimersByTimeAsync(3000);
        }
        expect(read).toEqual(Array.from({ length: 101 }, (_, n) => `e${n}`));
        const heartbeat = next(stream);
        await vi.advanceTimersByTimeAsync(5000);
        expect(await heartbeat).toMatchObject({ method: HEARTBEAT });
        expect(testHook(events).state().pushStreams).toBe(1);
    });

    it('keeps a stream whose client stops reading for less than a grant and then reads what waited', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const events = new EventsExtension();
        const handle = events.registerEvent('big', { emitOnly: true, payloadSchema: BIG });
        const stream = await open(serve(events), { name: 'big', cursor: null, heartbeatMs: 5000 });
        expect(await next(stream)).toMatchObject({ method: ACTIVE });

        // `for (…) await handle.emit(…)` queues every frame before the client reads one.
        for (let n = 0; n < 20; n++) await handle.emit(big(n));
        await vi.advanceTimersByTimeAsync(4000);
        const read: unknown[] = [];
        for (let n = 0; n < 20; n++) read.push(paramsOf(await next(stream))['eventId']);
        expect(read).toEqual(Array.from({ length: 20 }, (_, n) => `e${n}`));

        const heartbeat = next(stream);
        await vi.advanceTimersByTimeAsync(5000);
        expect(await heartbeat).toMatchObject({ method: HEARTBEAT });
        expect(testHook(events).state().pushStreams).toBe(1);
    });
});

describe('events/stream: on stdio, whose transport cannot tell how far its client has read', () => {
    const closing: Array<() => Promise<void>> = [];
    afterEach(async () => {
        for (const close of closing.splice(0)) await close();
    });

    // Opens a stream of emit-only type `i` (request id 1) over stdio, on a stdout that holds back its write callbacks while blocked; with a high-water mark of one byte, each frame waits for 'drain', so stdout holds none of the stream's frames beyond the one it is writing.
    async function stdioStream(events: EventsExtension) {
        const stdin = new PassThrough();
        const frames: JSONRPCMessage[] = [];
        const parked: Array<() => void> = [];
        let blocked = false;
        const stdout = new Writable({
            highWaterMark: 1,
            write(chunk: Buffer, _encoding, callback) {
                for (const line of chunk.toString().split('\n')) if (line.trim() !== '') frames.push(JSON.parse(line) as JSONRPCMessage);
                if (blocked) parked.push(callback);
                else callback();
            }
        });
        const served = serveStdio(() => new McpServer({ name: 'events-test', version: '1.0.0' }, { extensions: [events] }), {
            transport: new StdioServerTransport(stdin, stdout)
        });
        closing.push(() => served.close());
        const envelope = {
            [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
            [CLIENT_INFO_META_KEY]: { name: 'events-test-client', version: '1.0.0' },
            [CLIENT_CAPABILITIES_META_KEY]: {}
        };
        const send = (message: Record<string, unknown>) => stdin.write(JSON.stringify(message) + '\n');
        send({ jsonrpc: '2.0', id: 1, method: 'events/stream', params: { name: 'i', cursor: null, _meta: envelope } });
        await vi.waitFor(() => expect(frames).toEqual([expect.objectContaining({ method: ACTIVE })]));
        return {
            frames,
            // The eventIds of the event frames stdout has taken.
            written: () => frames.flatMap(frame => ('method' in frame && frame.method === EVENT ? [paramsOf(frame)['eventId']] : [])),
            block: () => void (blocked = true),
            release: () => {
                blocked = false;
                for (const callback of parked.splice(0)) callback();
            },
            cancel: () => send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, _meta: envelope } })
        };
    }

    it('ends an emit-only stream once emitBuffer.maxEvents live events wait and stdout has held its frame longer than the grant, and writes its final result once stdout drains', async () => {
        // The clock moves past the grant without running timers, so no heartbeat comes due.
        let skew = 0;
        const now = Date.now.bind(Date);
        vi.spyOn(Date, 'now').mockImplementation(() => now() + skew);
        const onUnsubscribe = vi.fn();
        const events = new EventsExtension({ emitBuffer: { maxEvents: 100 } });
        const handle = events.registerEvent('i', { emitOnly: true, payloadSchema: P, onUnsubscribe });
        const stdio = await stdioStream(events);
        stdio.block();
        // Within the 30 s grant, stdout still counts as writing however many wait.
        for (let n = 0; n < 150; n++) await handle.emit({ eventId: `e${n}`, data: { n } });
        expect(testHook(events).state().pushStreams).toBe(1);

        // Past the grant, the next live event finds stdout stalled with 150 waiting: the subscription ends, and no later emit is queued for it.
        skew = 30_001;
        await handle.emit({ eventId: 'e150', data: { n: 150 } });
        expect(testHook(events).state().pushStreams).toBe(0);
        await vi.waitFor(() => expect(onUnsubscribe).toHaveBeenCalledOnce());
        for (let n = 151; n < 1000; n++) await handle.emit({ eventId: `e${n}`, data: { n } });
        expect(testHook(events).state().emitBuffer).toEqual({ i: 100 });

        // Once the client reads again, the frame stdout held goes out, the queued events do not, and the final result tells it the stream ended.
        stdio.release();
        await vi.waitFor(() => expect(stdio.frames.at(-1)).toEqual(finalResult(1)));
        expect(stdio.written()).toEqual(['e0']);
        expect(onUnsubscribe).toHaveBeenCalledOnce();
    });

    it('ends an emit-only stream once emitBuffer.maxEvents live events have waited for a whole grant, though stdout takes each frame within it', async () => {
        // The clock moves without running timers, so no heartbeat comes due.
        let skew = 0;
        const now = Date.now.bind(Date);
        vi.spyOn(Date, 'now').mockImplementation(() => now() + skew);
        const onUnsubscribe = vi.fn();
        const events = new EventsExtension({ emitBuffer: { maxEvents: 10 } });
        const handle = events.registerEvent('i', { emitOnly: true, payloadSchema: P, onUnsubscribe });
        const stdio = await stdioStream(events);
        stdio.block();
        for (let n = 0; n < 10; n++) await handle.emit({ eventId: `e${n}`, data: { n } });

        // Every 10 s the client reads one frame while two more are emitted, so 10 or more stay waiting.
        let next = 10;
        for (const at of [10_000, 20_000]) {
            skew = at;
            for (const n of [next++, next++]) await handle.emit({ eventId: `e${n}`, data: { n } });
            const written = stdio.written().length;
            stdio.release();
            stdio.block();
            await vi.waitFor(() => expect(stdio.written()).toHaveLength(written + 1));
        }
        expect(testHook(events).state().pushStreams).toBe(1);

        // A grant after 10 first waited, the next live event finds them still waiting: the subscription ends.
        skew = 30_000;
        await handle.emit({ eventId: `e${next}`, data: { n: next } });
        expect(testHook(events).state().pushStreams).toBe(0);
        await vi.waitFor(() => expect(onUnsubscribe).toHaveBeenCalledOnce());
        stdio.release();
        await vi.waitFor(() => expect(stdio.frames.at(-1)).toEqual(finalResult(1)));
    });

    it('delivers a burst of twice emitBuffer.maxEvents emits started in one turn in full, while stdout keeps writing', async () => {
        const onUnsubscribe = vi.fn();
        const events = new EventsExtension({ emitBuffer: { maxEvents: 100 } });
        const handle = events.registerEvent('i', { emitOnly: true, payloadSchema: P, onUnsubscribe });
        const stdio = await stdioStream(events);

        await Promise.all(Array.from({ length: 200 }, (_, n) => handle.emit({ eventId: `e${n}`, data: { n } })));
        await vi.waitFor(() => expect(stdio.written()).toHaveLength(200));
        expect(stdio.written()).toEqual(Array.from({ length: 200 }, (_, n) => `e${n}`));
        expect(testHook(events).state().pushStreams).toBe(1);
        expect(onUnsubscribe).not.toHaveBeenCalled();
    });

    it('resolves terminate() once the stream has ended and onUnsubscribe ran, while stdout takes no frames, and then writes the queued events and terminated', async () => {
        const onUnsubscribe = vi.fn();
        const events = new EventsExtension();
        const handle = events.registerEvent('i', { emitOnly: true, payloadSchema: P, onUnsubscribe });
        const stdio = await stdioStream(events);
        stdio.block();
        for (let n = 0; n < 20; n++) await handle.emit({ eventId: `e${n}`, data: { n } });

        const terminating = handle.terminate(new EventsError('forbidden', 'Forbidden')).then(() => 'resolved');
        const timeout = new Promise(resolve => setTimeout(() => resolve('pending'), 1000));
        expect(await Promise.race([terminating, timeout])).toBe('resolved');
        expect(onUnsubscribe).toHaveBeenCalledOnce();
        expect(testHook(events).state().pushStreams).toBe(0);

        // The events emitted before terminate() go out ahead of `terminated`.
        stdio.release();
        await vi.waitFor(() => expect(stdio.frames.at(-1)).toEqual(finalResult(1)));
        expect(stdio.written()).toEqual(Array.from({ length: 20 }, (_, n) => `e${n}`));
        expect(stdio.frames.slice(-2)).toEqual([
            notification(TERMINATED, 1, { error: { code: -32_024, message: 'Forbidden' } }),
            finalResult(1)
        ]);
    });

    it('writes no queued event after notifications/cancelled ends the stream (SEP-3415: the server MUST stop delivering)', async () => {
        const onUnsubscribe = vi.fn();
        const events = new EventsExtension();
        const handle = events.registerEvent('i', { emitOnly: true, payloadSchema: P, onUnsubscribe });
        const stdio = await stdioStream(events);
        stdio.block();
        for (let n = 0; n < 50; n++) await handle.emit({ eventId: `e${n}`, data: { n } });

        stdio.cancel();
        await vi.waitFor(() => expect(testHook(events).state().pushStreams).toBe(0));
        expect(onUnsubscribe).toHaveBeenCalledOnce();
        stdio.release();
        await new Promise(resolve => setTimeout(resolve, 100));
        // The frame stdout held, and no final result: a server SHOULD NOT answer a cancelled request.
        expect(stdio.frames.slice(1)).toEqual([
            expect.objectContaining({ method: EVENT, params: expect.objectContaining({ eventId: 'e0' }) })
        ]);
    });
});

describe('events/stream: response modes', () => {
    it("streams under responseMode: 'json'", async () => {
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
