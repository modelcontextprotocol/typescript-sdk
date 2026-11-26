import type { TransportSendOptions } from '@modelcontextprotocol/core-internal';
import { ProtocolError, SdkError, SdkErrorCode, SUBSCRIPTION_ID_META_KEY } from '@modelcontextprotocol/core-internal';
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UnauthorizedError } from '../../../src/client/auth';
import { markAuthSeamEscape } from '../../../src/client/authSeam';
import type { EventSubscription, SubscribeOptions } from '../../../src/ext/events/index';
import { EventsError, NoCompatibleDeliveryModeError } from '../../../src/ext/events/index';
import type { SubscriptionQueue } from '../../../src/ext/events/subscription';
import type { Call, Handler } from './scripted';
import { authFailure, callsTo, connectEvents, descriptor, failSends, listing, occurrence, RpcError, script } from './scripted';

const subscriptions: EventSubscription[] = [];

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(async () => {
    await Promise.all(subscriptions.splice(0).map(subscription => subscription.cancel()));
    vi.useRealTimers();
    vi.restoreAllMocks();
});

/** Lets every in-flight request and its response settle without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

/** The eventId of the loop's next event, `undefined` when the loop is done. */
async function nextEventId(iterator: AsyncIterator<{ eventId: string }>): Promise<string | undefined> {
    const result = await iterator.next();
    return result.done ? undefined : result.value.eventId;
}

const tick = descriptor('tick', { delivery: ['push'] });
const schemaChanged = { code: -32_026, message: 'Unsupported', data: { feature: 'payloadSchema', reason: 'schema_changed' } };

/** One `events/stream` the scripted server holds open: the test sends its frames and ends it. */
interface ServerStream {
    call: Call;
    frame(method: string, params?: Record<string, unknown>): Promise<void>;
    active(params?: Record<string, unknown>): Promise<void>;
    /** The empty `StreamEventsResult`. */
    end(): Promise<void>;
    /** A JSON-RPC error response. */
    fail(error: { code: number; message: string; data?: Record<string, unknown> }): Promise<void>;
}

async function pushWith(list: Handler = listing(tick)) {
    const scripted = await connectEvents({ 'events/list': list, 'events/stream': () => new Promise<never>(() => {}) });
    const { events, calls, send } = scripted;
    const serverStream = (call: Call): ServerStream => {
        const meta = { [SUBSCRIPTION_ID_META_KEY]: call.id };
        const frame = (method: string, params: Record<string, unknown> = {}) =>
            send({ jsonrpc: '2.0', method, params: { ...params, _meta: { ...(params['_meta'] as object | undefined), ...meta } } });
        return {
            call,
            frame,
            active: params => frame('notifications/events/active', { cursor: null, truncated: false, heartbeatMs: 30_000, ...params }),
            end: () => send({ jsonrpc: '2.0', id: call.id, result: { resultType: 'complete', _meta: meta } }),
            fail: error => send({ jsonrpc: '2.0', id: call.id, error })
        };
    };
    const streams = () => callsTo(calls, 'events/stream').map(call => serverStream(call));
    const last = () => streams().at(-1)!;
    return {
        ...scripted,
        streams,
        last,
        lists: () => callsTo(calls, 'events/list'),
        /** Subscribes, answering the first stream with `first` (default: `active`). */
        subscribe: async (options: Partial<SubscribeOptions> = {}, first: (stream: ServerStream) => Promise<void> = s => s.active()) => {
            const subscribing = events.subscribe({ name: 'tick', delivery: 'push', ...options });
            await settle();
            await first(last());
            const subscription = await subscribing;
            subscriptions.push(subscription);
            await settle();
            return subscription;
        }
    };
}

/** Ends the request stream of `id` the way a dropped HTTP response stream does. */
function endRequestStream(send: MockInstance, id: Call['id']): void {
    const call = send.mock.calls.find(([message]) => (message as { id?: unknown }).id === id)!;
    (call[1] as TransportSendOptions).onRequestStreamEnd!();
}

describe('push delivery', () => {
    it('opens events/stream with the subscription, its Mcp-Param headers and maxAgeMs, and no heartbeatMs', async () => {
        const annotated = descriptor('tick', {
            delivery: ['poll', 'push'],
            inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' } } }
        });
        const { last, streams, subscribe } = await pushWith(listing(annotated));
        const sub = await subscribe({ delivery: undefined, arguments: { region: 'us-west1' }, cursor: 'c0', maxAgeMs: 300_000 }, s =>
            s.active({ cursor: 'c1' })
        );

        expect(sub.deliveryMode).toBe('push');
        expect(streams()[0]!.call.params).toEqual({
            name: 'tick',
            arguments: { region: 'us-west1' },
            cursor: 'c0',
            maxAgeMs: 300_000,
            _meta: expect.any(Object)
        });
        expect(streams()[0]!.call.headers).toEqual({ 'Mcp-Param-Region': 'us-west1' });

        // A reopen 500 ms later sends maxAgeMs grown by that time, so the floor stays where subscribe() put it.
        await last().end();
        await vi.advanceTimersByTimeAsync(500);
        expect(streams()).toHaveLength(2);
        expect(last().call.params).toEqual({
            name: 'tick',
            arguments: { region: 'us-west1' },
            cursor: 'c1',
            maxAgeMs: 300_500,
            _meta: expect.any(Object)
        });
        expect(last().call.headers).toEqual({ 'Mcp-Param-Region': 'us-west1' });
    });

    it('delivers each eventId once, moves the cursor past events the loop is done with, and reports truncated through onGap', async () => {
        const onGap = vi.fn();
        const { last, subscribe } = await pushWith();
        const sub = await subscribe({ cursor: 'c0', onGap }, s => s.active({ cursor: 'c5', truncated: true }));
        expect(onGap).toHaveBeenCalledExactlyOnceWith('c5');
        expect(sub.cursor).toBe('c5');

        await last().frame('notifications/events/event', { ...occurrence('e1'), cursor: 'c6' });
        await last().frame('notifications/events/error', { error: { code: -32_603, message: 'UpstreamError' } });
        await last().frame('notifications/events/event', { ...occurrence('e1'), cursor: 'c6' });
        await last().frame('notifications/events/event', { ...occurrence('e2'), cursor: 'c7' });
        await last().active({ cursor: 'c9', truncated: true });
        expect(onGap).toHaveBeenLastCalledWith('c9');

        const iterator = sub[Symbol.asyncIterator]();
        expect(sub.cursor).toBe('c5');
        expect(await nextEventId(iterator)).toBe('e1');
        expect(await nextEventId(iterator)).toBe('e2');
        expect(sub.cursor).toBe('c6');
        let settled = false;
        void iterator.next().then(() => (settled = true));
        await settle();
        expect(settled).toBe(false);
        expect(sub.cursor).toBe('c9');
    });

    it('yields events without the stream subscription id in _meta, keeping the author _meta', async () => {
        const { last, subscribe } = await pushWith();
        const sub = await subscribe();
        await last().frame('notifications/events/event', { ...occurrence('e1'), cursor: 'c1', _meta: { 'com.example/trace': 't1' } });
        await last().frame('notifications/events/event', { ...occurrence('e2'), cursor: 'c2' });

        const iterator = sub[Symbol.asyncIterator]();
        const first = await iterator.next();
        const second = await iterator.next();
        expect(first.value).toEqual({ ...occurrence('e1'), cursor: 'c1', _meta: { 'com.example/trace': 't1' } });
        expect(second.value).toEqual({ ...occurrence('e2'), cursor: 'c2' });
        expect(second.value).not.toHaveProperty('_meta');
    });

    it('reports a malformed frame and a throwing onGap to onerror, and keeps delivering', async () => {
        const failure = new Error('onGap failed');
        const { client, last, subscribe } = await pushWith();
        const errors: Error[] = [];
        client.onerror = error => void errors.push(error);
        const sub = await subscribe(
            {
                cursor: 'c0',
                onGap: () => {
                    throw failure;
                }
            },
            s => s.active({ cursor: 'c1', truncated: true })
        );

        await last().frame('notifications/events/event', { name: 'tick', cursor: 'c2' });
        await last().frame('notifications/events/event', { ...occurrence('e1'), cursor: 'c3' });
        expect(errors).toEqual([failure, expect.objectContaining({ message: expect.stringContaining('notifications/events/event') })]);
        expect(await nextEventId(sub[Symbol.asyncIterator]())).toBe('e1');
        expect(sub.cursor).toBe('c1');
    });

    it('leaves no timer and no reopen when a callback cancels the subscription inside a frame', async () => {
        // `trigger` sends frames on a subscription whose onGap (or client.onerror) calls cancel() synchronously.
        const cancelledInside = async (
            via: 'onGap' | 'onerror',
            trigger: (last: () => ServerStream) => Promise<void>
        ): Promise<{ timers: number; streams: number }> => {
            const { client, last, streams, subscribe } = await pushWith();
            const subscribed: { sub?: EventSubscription } = {};
            const cancel = () => void subscribed.sub?.cancel();
            if (via === 'onerror') client.onerror = cancel;
            subscribed.sub = await subscribe({ cursor: 'c0', ...(via === 'onGap' && { onGap: cancel }) }, s =>
                s.active({ cursor: 'c1', heartbeatMs: 5000 })
            );
            await trigger(last);
            await settle();
            const timers = vi.getTimerCount();
            await vi.advanceTimersByTimeAsync(120_000);
            return { timers, streams: streams().length };
        };

        // The truncated `active` that opens a reconnected stream.
        const reopened = await cancelledInside('onGap', async last => {
            await last().end();
            await vi.advanceTimersByTimeAsync(500);
            await last().active({ cursor: 'c2', truncated: true, heartbeatMs: 5000 });
        });
        const midStream = await cancelledInside('onGap', last => last().active({ cursor: 'c2', truncated: true, heartbeatMs: 5000 }));
        const malformed = await cancelledInside('onerror', last => last().frame('notifications/events/event', { name: 'tick' }));
        expect({ reopened, midStream, malformed }).toEqual({
            reopened: { timers: 0, streams: 2 },
            midStream: { timers: 0, streams: 1 },
            malformed: { timers: 0, streams: 1 }
        });
    });

    it('closes the stream quietly once 1 000 events wait for the loop, and reopens from the last cursor once the loop has taken half of them', async () => {
        const { client, notifications, last, streams, subscribe } = await pushWith();
        const errors: Error[] = [];
        client.onerror = error => void errors.push(error);
        const sub = await subscribe({}, s => s.active({ cursor: 'c0', heartbeatMs: 5000 }));
        for (let n = 1; n <= 1000; n++) await last().frame('notifications/events/event', { ...occurrence(`e${n}`), cursor: `c${n}` });
        expect(notifications).toContainEqual({
            method: 'notifications/cancelled',
            params: expect.objectContaining({ requestId: streams()[0]!.call.id })
        });
        // A frame sent before the server saw the cancellation goes nowhere, and no countdown or reopen runs while the loop is behind.
        await streams()[0]!.frame('notifications/events/event', { ...occurrence('e1001'), cursor: 'c1001' });
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(streams()).toHaveLength(1);

        // Taking 499 events reopens nothing; the 500th leaves 500 waiting, and the stream reopens from the last cursor.
        const iterator = sub[Symbol.asyncIterator]();
        const ids: string[] = [];
        while (ids.length < 499) ids.push((await nextEventId(iterator))!);
        await settle();
        expect(streams()).toHaveLength(1);
        ids.push((await nextEventId(iterator))!);
        await settle();
        expect(streams()).toHaveLength(2);
        expect(last().call.params['cursor']).toBe('c1000');
        await last().active({ cursor: 'c1000', heartbeatMs: 5000 });
        await last().frame('notifications/events/event', { ...occurrence('e1001'), cursor: 'c1001' });

        while (ids.length < 1001) ids.push((await nextEventId(iterator))!);
        expect(ids).toEqual(Array.from({ length: 1001 }, (_, n) => `e${n + 1}`));
        expect(errors).toEqual([]);
        // The reopened stream counts its own silence: three grants after its last message, it reconnects.
        await vi.advanceTimersByTimeAsync(15_499);
        expect(streams()).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(streams()).toHaveLength(3);
        expect(last().call.params['cursor']).toBe('c1001');
    });

    it('keeps a full stream open inside a batch whose events share the cursor before it, and closes it at the batch end', async () => {
        const { last, streams, subscribe } = await pushWith();
        const sub = await subscribe({}, s => s.active({ cursor: 'c0' }));
        // As the SDK server sends a check batch: every event at the batch's start cursor but the last.
        for (let n = 1; n <= 1200; n++) {
            await last().frame('notifications/events/event', { ...occurrence(`e${n}`), cursor: n === 1200 ? 'c1' : 'c0' });
        }
        expect(streams()).toHaveLength(1);
        await settle();

        // The stream closed at the batch end with 1 200 waiting; it reopens from there once 500 wait.
        const iterator = sub[Symbol.asyncIterator]();
        const ids: string[] = [];
        while (ids.length < 699) ids.push((await nextEventId(iterator))!);
        await settle();
        expect(streams()).toHaveLength(1);
        ids.push((await nextEventId(iterator))!);
        await settle();
        expect(streams()).toHaveLength(2);
        expect(last().call.params['cursor']).toBe('c1');
        while (ids.length < 1200) ids.push((await nextEventId(iterator))!);
        expect(ids).toEqual(Array.from({ length: 1200 }, (_, n) => `e${n + 1}`));
    });

    it('reopens a stream once per half of the queue a slow loop drains, not once per event it takes', async () => {
        const { streams, subscribe } = await pushWith();
        // The server's side: every stream replays its log from the cursor it is opened at, 1 000 events at a time.
        const feed = async (stream: ServerStream): Promise<void> => {
            const from = Number(String(stream.call.params['cursor']).slice(1));
            await stream.active({ cursor: `c${from}` });
            for (let n = from + 1; n <= from + 1000; n++) {
                await stream.frame('notifications/events/event', { ...occurrence(`e${n}`), cursor: `c${n}` });
            }
        };
        const sub = await subscribe({ cursor: 'c0' }, feed);
        let fed = 1;
        const iterator = sub[Symbol.asyncIterator]();
        const ids: string[] = [];
        while (ids.length < 2000 && streams().length <= 10) {
            ids.push((await nextEventId(iterator))!);
            await settle();
            while (streams().length > fed) await feed(streams()[fed++]!);
        }
        // Closed at 1 000 waiting, then reopened after each 500 the loop took: from c1000, c1500, c2000 and c2500.
        expect(streams().map(stream => stream.call.params['cursor'])).toEqual(['c0', 'c1000', 'c1500', 'c2000', 'c2500']);
        expect(ids).toEqual(Array.from({ length: 2000 }, (_, n) => `e${n + 1}`));
    });

    it('drops the oldest events of a type that cannot resume once 1 000 wait, keeps the stream, and reports one gap per run of drops', async () => {
        const onGap = vi.fn();
        const { last, notifications, streams, subscribe } = await pushWith();
        const sub = await subscribe({ onGap }, s => s.active({ cursor: null }));
        const send = async (from: number, to: number) => {
            for (let n = from; n <= to; n++) await last().frame('notifications/events/event', { ...occurrence(`e${n}`), cursor: null });
        };
        await send(1, 1500);
        expect(onGap).toHaveBeenCalledExactlyOnceWith(null);
        expect(streams()).toHaveLength(1);
        expect(notifications.filter(notification => notification.method === 'notifications/cancelled')).toEqual([]);

        // The loop gets the newest 1 000, in order.
        const iterator = sub[Symbol.asyncIterator]();
        const ids: string[] = [];
        while (ids.length < 1000) ids.push((await nextEventId(iterator))!);
        expect(ids).toEqual(Array.from({ length: 1000 }, (_, n) => `e${n + 501}`));
        expect(onGap).toHaveBeenCalledOnce();

        // A later run of drops, after the queue was below the limit again, is another gap.
        await send(1501, 2501);
        expect(onGap).toHaveBeenCalledTimes(2);
        expect(await nextEventId(iterator)).toBe('e1502');
        expect(sub.cursor).toBeNull();
    });

    it('reports one gap for a sustained overload of a type that cannot resume, until the loop has taken half the queue', async () => {
        const onGap = vi.fn();
        const { last, subscribe } = await pushWith();
        const sub = await subscribe({ onGap }, s => s.active({ cursor: null }));
        let sent = 0;
        const send = async (count: number) => {
            for (let n = 0; n < count; n++) {
                sent += 1;
                await last().frame('notifications/events/event', { ...occurrence(`e${sent}`), cursor: null });
            }
        };
        await send(1001);
        expect(onGap).toHaveBeenCalledExactlyOnceWith(null);

        // The server sends two events for each one the loop takes: still one episode.
        const iterator = sub[Symbol.asyncIterator]();
        for (let cycle = 0; cycle < 20; cycle++) {
            await nextEventId(iterator);
            await send(2);
        }
        expect(onGap).toHaveBeenCalledOnce();

        // Once the loop has taken the queue down to 500, the next drop starts another episode.
        for (let n = 0; n < 500; n++) await nextEventId(iterator);
        await settle();
        await send(501);
        expect(onGap).toHaveBeenCalledTimes(2);
    });

    describe('leaving a pause', () => {
        // A subscription whose queue filled with 1 000 events, so the driver closed its stream and waits for the loop.
        async function paused() {
            const push = await pushWith();
            const sub = await push.subscribe({}, s => s.active({ cursor: 'c0', heartbeatMs: 5000 }));
            for (let n = 1; n <= 1000; n++) {
                await push.last().frame('notifications/events/event', { ...occurrence(`e${n}`), cursor: `c${n}` });
            }
            expect(push.notifications.filter(notification => notification.method === 'notifications/cancelled')).toHaveLength(1);
            return { ...push, sub, iterator: sub[Symbol.asyncIterator]() };
        }

        it('ends on cancel(): cancel() resolves, and no reopen or timer follows', async () => {
            const { sub, iterator, streams } = await paused();
            for (let n = 0; n < 499; n++) await iterator.next();
            await sub.cancel();
            expect(await iterator.next()).toEqual({ done: true, value: undefined });
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(120_000);
            expect(streams()).toHaveLength(1);
        });

        it('ends on a closed connection: the loop gets what waited, then ConnectionClosed, and no reopen or timer follows', async () => {
            const { client, sub, iterator, streams } = await paused();
            // The wait the paused driver is in; a rejected loop never calls return(), so the close itself must release it.
            let released = false;
            void (sub as unknown as SubscriptionQueue<unknown>).room().then(() => (released = true));
            await client.close();
            await settle();
            expect(released).toBe(true);
            const ids: Array<string | undefined> = [];
            for (let n = 0; n < 1000; n++) ids.push(await nextEventId(iterator));
            expect(ids).toEqual(Array.from({ length: 1000 }, (_, n) => `e${n + 1}`));
            await expect(iterator.next()).rejects.toMatchObject({ code: SdkErrorCode.ConnectionClosed });
            await sub.cancel();
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(120_000);
            expect(streams()).toHaveLength(1);
        });

        it('ends when the loop is left: no reopen or timer follows', async () => {
            const { sub, streams } = await paused();
            let taken = 0;
            for await (const _event of sub) {
                taken += 1;
                if (taken === 3) break;
            }
            await sub.cancel();
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(120_000);
            expect(streams()).toHaveLength(1);
        });
    });

    it('reports notifications/events/error as a retried failure: at once, then counted once a minute, and keeps the stream', async () => {
        const { client, last, streams, subscribe } = await pushWith();
        const errors: Error[] = [];
        client.onerror = error => void errors.push(error);
        const sub = await subscribe({}, s => s.active({ cursor: 'c0', heartbeatMs: 30_000 }));
        const failure = { error: { code: -32_603, message: 'upstream unavailable' } };

        await last().frame('notifications/events/error', failure);
        expect(errors).toEqual([
            expect.objectContaining({ message: "push subscription to 'tick' failed and is retried: upstream unavailable" })
        ]);
        for (let second = 5; second < 60; second += 5) {
            await vi.advanceTimersByTimeAsync(5000);
            await last().frame('notifications/events/error', failure);
        }
        expect(errors).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(5000);
        expect(errors).toHaveLength(2);
        expect(errors[1]!.message).toBe(
            "push subscription to 'tick': 11 more retried failures since the last report, the latest: upstream unavailable"
        );
        expect(streams()).toHaveLength(1);
        await last().frame('notifications/events/event', { ...occurrence('e1'), cursor: 'c1' });
        expect(await nextEventId(sub[Symbol.asyncIterator]())).toBe('e1');
    });

    it('advances the cursor on heartbeats', async () => {
        const { last, subscribe } = await pushWith();
        const sub = await subscribe({}, s => s.active({ cursor: 'c1' }));
        expect(sub.cursor).toBe('c1');

        await last().frame('notifications/events/heartbeat', { cursor: 'c9' });
        expect(sub.cursor).toBe('c9');
    });

    it('reconnects with the last cursor after 3 × the granted heartbeat', async () => {
        const { notifications, last, streams, subscribe } = await pushWith();
        await subscribe({}, s => s.active({ cursor: 'c1', heartbeatMs: 5000 }));

        await vi.advanceTimersByTimeAsync(15_499);
        expect(streams()).toHaveLength(1);
        expect(notifications).toContainEqual({
            method: 'notifications/cancelled',
            params: expect.objectContaining({ requestId: streams()[0]!.call.id })
        });
        await vi.advanceTimersByTimeAsync(1);
        expect(streams()).toHaveLength(2);
        expect(last().call.params['cursor']).toBe('c1');
    });

    it('counts the silence from the last message, with the grant of the last active', async () => {
        const { last, streams, subscribe } = await pushWith();
        await subscribe({}, s => s.active({ cursor: 'c1', heartbeatMs: 5000 }));

        await vi.advanceTimersByTimeAsync(10_000);
        await last().frame('notifications/events/heartbeat', { cursor: 'c2' });
        await vi.advanceTimersByTimeAsync(10_000);
        await last().active({ cursor: 'c3', truncated: true, heartbeatMs: 10_000 });
        await vi.advanceTimersByTimeAsync(29_999);
        expect(streams()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(501);
        expect(streams()).toHaveLength(2);
        expect(last().call.params['cursor']).toBe('c3');
    });

    it('waits a jittered delay before reconnecting', async () => {
        const { client, last, streams, subscribe } = await pushWith();
        const send = vi.spyOn(client.transport!, 'send');
        await subscribe({}, s => s.active({ cursor: 'c1' }));

        endRequestStream(send, last().call.id);
        await vi.advanceTimersByTimeAsync(499);
        expect(streams()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(streams()).toHaveLength(2);
        expect(last().call.params['cursor']).toBe('c1');
    });

    it('doubles the reconnect delay up to 30 s until a stream is active again', async () => {
        const { last, streams, subscribe } = await pushWith();
        const sub = await subscribe({}, s => s.active({ cursor: 'c1' }));
        await last().end();

        // random() is 0.5: half of min(30 s, 1 s × 2^attempt).
        for (const delay of [500, 1000, 2000, 4000, 8000, 15_000, 15_000]) {
            const before = streams().length;
            await vi.advanceTimersByTimeAsync(delay - 1);
            expect(streams()).toHaveLength(before);
            await vi.advanceTimersByTimeAsync(1);
            expect(streams()).toHaveLength(before + 1);
            expect(last().call.params['cursor']).toBe('c1');
            await last().end();
        }
        await vi.advanceTimersByTimeAsync(15_000);
        await last().active({ cursor: 'c2' });
        await last().end();
        await vi.advanceTimersByTimeAsync(500);
        expect(last().call.params['cursor']).toBe('c2');
        expect(sub.cursor).toBe('c2');
    });

    it('retries and reports a reopened stream that ends before its active, and reopens quietly after one that ends after it', async () => {
        const { client, last, streams, subscribe } = await pushWith();
        const errors: Error[] = [];
        client.onerror = error => void errors.push(error);
        const sub = await subscribe({}, s => s.active({ cursor: 'c1' }));

        await last().end();
        await vi.advanceTimersByTimeAsync(500);
        expect(streams()).toHaveLength(2);
        expect(errors).toEqual([]);

        await last().end();
        await vi.advanceTimersByTimeAsync(1000);
        expect(streams()).toHaveLength(3);
        expect(last().call.params['cursor']).toBe('c1');
        expect(errors).toEqual([
            expect.objectContaining({
                message:
                    "push subscription to 'tick' failed and is retried: events/stream ended before its first valid notifications/events/active",
                cause: expect.objectContaining({ code: SdkErrorCode.InvalidResult })
            })
        ]);
        await last().active({ cursor: 'c2' });
        await last().frame('notifications/events/event', { ...occurrence('e1'), cursor: 'c3' });
        expect(await nextEventId(sub[Symbol.asyncIterator]())).toBe('e1');
    });

    it('reports onGap(null) once per reopen of a type without replay whose stream ended or went silent after its active', async () => {
        const onGap = vi.fn();
        const { last, streams, subscribe } = await pushWith();
        await subscribe({ onGap }, s => s.active({ cursor: null, heartbeatMs: 5000 }));

        // The server ends the stream; the reopen starts from now, and its active reports what may have happened meanwhile.
        await last().end();
        await vi.advanceTimersByTimeAsync(500);
        expect(streams()).toHaveLength(2);
        expect(onGap).not.toHaveBeenCalled();
        await last().active({ cursor: null, heartbeatMs: 5000 });
        expect(onGap).toHaveBeenCalledExactlyOnceWith(null);

        // The stream goes silent for three grants, and a reopen that ends before its active comes in between: one more report.
        await vi.advanceTimersByTimeAsync(15_500);
        expect(streams()).toHaveLength(3);
        await last().end();
        await vi.advanceTimersByTimeAsync(1000);
        expect(streams()).toHaveLength(4);
        await last().active({ cursor: null });
        expect(onGap.mock.calls).toEqual([[null], [null]]);
    });

    it('reports no gap for a reopen of a type with a cursor, which resumes from it', async () => {
        const onGap = vi.fn();
        const { last, streams, subscribe } = await pushWith();
        await subscribe({ onGap }, s => s.active({ cursor: 'c1' }));
        await last().end();
        await vi.advanceTimersByTimeAsync(500);
        expect(streams()).toHaveLength(2);
        await last().active({ cursor: 'c1' });
        expect(onGap).not.toHaveBeenCalled();
    });

    it('sends maxAgeMs on every reopen, after a heartbeat too, so a reopen mid-replay stays cut', async () => {
        const { last, subscribe } = await pushWith();
        // As the SDK server answers a check from h1 whose `old` event is older than the floor: without maxAgeMs, `old` comes too.
        const replay = async () => {
            const { maxAgeMs } = last().call.params;
            await last().active({ cursor: 'h1', truncated: true });
            if (maxAgeMs === undefined) await last().frame('notifications/events/event', { ...occurrence('old'), cursor: 'h1' });
            await last().frame('notifications/events/event', { ...occurrence('new'), cursor: 'h1' });
        };
        const sub = await subscribe({ cursor: 'h1', maxAgeMs: 300_000 }, replay);
        await last().frame('notifications/events/heartbeat', { cursor: 'h1' });

        // The stream drops after a heartbeat, while the check still pages through the replay from h1.
        await last().end();
        await vi.advanceTimersByTimeAsync(500);
        expect(last().call.params).toMatchObject({ cursor: 'h1', maxAgeMs: 300_500 });
        await replay();
        await last().frame('notifications/events/event', { ...occurrence('newer'), cursor: 'h2' });

        await last().end();
        await vi.advanceTimersByTimeAsync(500);
        expect(last().call.params).toMatchObject({ cursor: 'h2', maxAgeMs: 301_000 });
        const iterator = sub[Symbol.asyncIterator]();
        expect([await nextEventId(iterator), await nextEventId(iterator)]).toEqual(['new', 'newer']);
    });

    it('reconnects with the last cursor after an error that is not an Events kind', async () => {
        const { last, streams, subscribe } = await pushWith();
        const sub = await subscribe({}, s => s.active({ cursor: 'c1' }));

        await last().fail({ code: -32_603, message: 'Internal error' });
        await vi.advanceTimersByTimeAsync(500);
        expect(streams()).toHaveLength(2);
        expect(last().call.params['cursor']).toBe('c1');
        await last().active({ cursor: 'c2' });
        await last().frame('notifications/events/event', { ...occurrence('e1'), cursor: 'c3' });
        expect(await nextEventId(sub[Symbol.asyncIterator]())).toBe('e1');
    });

    it('ends the loop on an auth failure of a reopen, without reopening again', async () => {
        const { client, last, streams, subscribe } = await pushWith();
        const sub = await subscribe({}, s => s.active({ cursor: 'c1' }));
        const reopens = failSends(client, 'events/stream', authFailure);
        const pending = sub[Symbol.asyncIterator]()
            .next()
            .catch((error_: unknown) => error_);

        await last().end();
        await vi.advanceTimersByTimeAsync(500);
        expect(await pending).toBeInstanceOf(UnauthorizedError);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(reopens()).toBe(1);
        expect(streams()).toHaveLength(1);
    });

    it('fails the iterator on terminated forbidden', async () => {
        const { last, streams, subscribe } = await pushWith();
        const sub = await subscribe();
        await last().frame('notifications/events/event', { ...occurrence('e1'), cursor: 'c1' });
        await last().frame('notifications/events/terminated', {
            error: { code: -32_024, message: 'Forbidden', data: { reason: 'Access revoked' } }
        });
        await last().end();

        const iterator = sub[Symbol.asyncIterator]();
        expect(await nextEventId(iterator)).toBe('e1');
        const error = await iterator.next().catch((error_: unknown) => error_);
        expect(error).toBeInstanceOf(EventsError);
        expect(error).toMatchObject({ kind: 'forbidden', data: { reason: 'Access revoked' } });
        expect(await iterator.next()).toEqual({ done: true, value: undefined });
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(streams()).toHaveLength(1);
    });

    it('fails the iterator when a reopen is refused with an Events kind other than notFound or a schema change', async () => {
        for (const refusal of [
            { code: -32_024, message: 'Forbidden' },
            { code: -32_602, message: 'Invalid arguments' },
            { code: -32_025, message: 'Too many subscriptions', data: { limit: 'subscriptions' } },
            { code: -32_026, message: 'Unsupported', data: { feature: 'deliveryMode', value: 'push' } },
            { code: -32_027, message: 'Callback endpoint error', data: { reason: 'timeout' } }
        ]) {
            const { lists, last, streams, subscribe } = await pushWith();
            const sub = await subscribe({}, s => s.active({ cursor: 'c1' }));
            await last().end();
            await vi.advanceTimersByTimeAsync(500);
            const pending = sub[Symbol.asyncIterator]()
                .next()
                .catch((error_: unknown) => error_);

            await last().fail(refusal);
            const error = await pending;
            expect(error).toBeInstanceOf(EventsError);
            expect(error).toMatchObject({ code: refusal.code });
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(streams()).toHaveLength(2);
            expect(lists()).toHaveLength(1);
        }
    });

    it('reconnects after schema_changed when the event is still listed', async () => {
        const onGap = vi.fn();
        const { lists, last, streams, subscribe } = await pushWith();
        const sub = await subscribe({ onGap }, s => s.active({ cursor: 'c1' }));

        await last().frame('notifications/events/terminated', { error: schemaChanged });
        await last().end();
        await settle();
        expect(lists()).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(500);
        expect(streams()).toHaveLength(2);
        expect(last().call.params['cursor']).toBe('c1');

        // This server still accepts the last cursor after the change: no reset, no gap.
        await last().active({ cursor: 'c1' });
        await last().frame('notifications/events/event', { ...occurrence('e1'), cursor: 'c2' });
        expect(await nextEventId(sub[Symbol.asyncIterator]())).toBe('e1');
        expect(onGap).not.toHaveBeenCalled();
    });

    it('starts again from now when the server keeps refusing the last cursor after a schema change', async () => {
        const onGap = vi.fn();
        const { lists, last, streams, subscribe } = await pushWith();
        const sub = await subscribe({ onGap }, s => s.active({ cursor: 'c1' }));

        await last().frame('notifications/events/terminated', { error: schemaChanged });
        await last().end();
        await vi.advanceTimersByTimeAsync(500);
        await last().fail(schemaChanged);
        await vi.advanceTimersByTimeAsync(1000);

        expect(streams().map(stream => stream.call.params['cursor'])).toEqual([null, 'c1', null]);
        expect(lists()).toHaveLength(3);
        await last().active({ cursor: 'v2:0' });
        expect(onGap).toHaveBeenCalledExactlyOnceWith('v2:0');
        expect(sub.cursor).toBe('v2:0');
    });

    it('reopens after notFound while the event is listed, and fails once it is not', async () => {
        const listed = [[tick], [tick], []];
        const { lists, last, streams, subscribe } = await pushWith(() => ({ events: listed.shift() ?? [] }));
        const sub = await subscribe({}, s => s.active({ cursor: 'c1' }));
        const pending = sub[Symbol.asyncIterator]()
            .next()
            .catch((error_: unknown) => error_);
        const notFound = { code: -32_023, message: 'Not found', data: { kind: 'event' } };

        await last().frame('notifications/events/terminated', { error: notFound });
        await last().end();
        await vi.advanceTimersByTimeAsync(500);
        expect(streams()).toHaveLength(2);
        expect(last().call.params['cursor']).toBe('c1');

        await last().fail(notFound);
        const error = await pending;
        expect(error).toBeInstanceOf(EventsError);
        expect(error).toMatchObject({ kind: 'notFound', data: { kind: 'event' } });
        expect(lists()).toHaveLength(3);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('re-lists once after -32020 and reopens with fresh Mcp-Param headers, failing on a second mismatch', async () => {
        const annotated = descriptor('tick', {
            delivery: ['push'],
            inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' } } }
        });
        // The first listing predates the annotation, so the first stream goes out without the header.
        const listed = [tick, annotated];
        const { lists, last, streams, subscribe } = await pushWith(() => ({ events: [listed.length > 1 ? listed.shift()! : listed[0]!] }));
        const mismatch = { code: -32_020, message: 'Mcp-Param-Region header mismatch' };
        const sub = await subscribe({ arguments: { region: 'us-west1' } }, async first => {
            await first.fail(mismatch);
            await vi.advanceTimersByTimeAsync(500);
            await last().active({ cursor: 'c1' });
        });

        expect(lists()).toHaveLength(2);
        expect(streams().map(stream => stream.call.headers['Mcp-Param-Region'])).toEqual([undefined, 'us-west1']);

        // A mismatch after a stream was active again re-lists again; the next one in a row fails the loop.
        await last().end();
        await vi.advanceTimersByTimeAsync(500);
        await last().fail(mismatch);
        await vi.advanceTimersByTimeAsync(1000);
        expect(lists()).toHaveLength(3);
        expect(streams()).toHaveLength(4);
        const pending = sub[Symbol.asyncIterator]()
            .next()
            .catch((error_: unknown) => error_);
        await last().fail(mismatch);
        const error = await pending;
        expect(error).toBeInstanceOf(ProtocolError);
        expect(error).toMatchObject({ code: -32_020 });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects subscribe() when the first stream is refused, leaving nothing running', async () => {
        const refusals = [
            { code: -32_023, message: 'Not found', data: { kind: 'event' } },
            { code: -32_602, message: 'Invalid arguments' },
            { code: -32_024, message: 'Forbidden' },
            { code: -32_025, message: 'Too many subscriptions', data: { limit: 'subscriptions' } },
            { code: -32_026, message: 'Unsupported', data: { feature: 'deliveryMode', value: 'push' } },
            // Without a cursor there is no stale one to drop, so a schema change refuses too.
            schemaChanged
        ];
        for (const refusal of refusals) {
            const { events, lists, last, streams } = await pushWith();
            const subscribing = events.subscribe({ name: 'tick', delivery: 'push' }).catch((error_: unknown) => error_);
            await settle();
            await last().fail(refusal);

            const error = await subscribing;
            expect(error).toBeInstanceOf(EventsError);
            expect(error).toMatchObject({ code: refusal.code });
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(120_000);
            expect(streams()).toHaveLength(1);
            // A refused delivery mode lists the event types again, which still select it.
            expect(lists()).toHaveLength(refusal.data?.feature === 'deliveryMode' ? 2 : 1);
        }
    });

    it('rejects subscribe() when the first stream mismatches Mcp-Param headers again after a re-list', async () => {
        const { events, lists, last, streams } = await pushWith();
        const mismatch = { code: -32_020, message: 'Mcp-Param-Region header mismatch' };
        const subscribing = events.subscribe({ name: 'tick', delivery: 'push' }).catch((error_: unknown) => error_);
        await settle();
        await last().fail(mismatch);
        await vi.advanceTimersByTimeAsync(500);
        await last().fail(mismatch);

        const error = await subscribing;
        expect(error).toBeInstanceOf(ProtocolError);
        expect(error).toMatchObject({ code: -32_020 });
        expect(streams()).toHaveLength(2);
        expect(lists()).toHaveLength(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('resolves subscribe() after a transient first-stream failure and delivers after the reconnect', async () => {
        const { last, streams, subscribe } = await pushWith();
        const sub = await subscribe({ cursor: 'c0' }, first => first.fail({ code: -32_603, message: 'Internal error' }));
        expect(streams()).toHaveLength(1);
        expect(sub.cursor).toBe('c0');

        await vi.advanceTimersByTimeAsync(500);
        expect(streams()).toHaveLength(2);
        expect(last().call.params['cursor']).toBe('c0');
        await last().active({ cursor: 'c1' });
        await last().frame('notifications/events/event', { ...occurrence('e1'), cursor: 'c2' });
        expect(await nextEventId(sub[Symbol.asyncIterator]())).toBe('e1');
    });

    it('drops a stale cursor that the first stream refuses for a schema change, and starts from now', async () => {
        const onGap = vi.fn();
        const { lists, last, streams, subscribe } = await pushWith();
        const sub = await subscribe({ cursor: 'stale', onGap }, async first => {
            await first.fail(schemaChanged);
            await vi.advanceTimersByTimeAsync(500);
            await last().active({ cursor: 'v2:0' });
        });

        expect(streams().map(stream => stream.call.params['cursor'])).toEqual(['stale', null]);
        expect(lists()).toHaveLength(2);
        expect(onGap).toHaveBeenCalledExactlyOnceWith('v2:0');
        expect(sub.cursor).toBe('v2:0');
    });

    it('rejects subscribe() after a schema change refuses its cursor when the type is gone or no longer pushed', async () => {
        const staleCursorAgainst = async (relisted: ReturnType<typeof descriptor>[]) => {
            const listed = [[tick], relisted];
            const { events, last, streams } = await pushWith(() => ({ events: listed.shift() ?? relisted }));
            const subscribing = events.subscribe({ name: 'tick', delivery: 'push', cursor: 'stale' }).catch((error_: unknown) => error_);
            await settle();
            await last().fail(schemaChanged);
            return { error: await subscribing, streams: streams().length, timers: vi.getTimerCount() };
        };

        const gone = await staleCursorAgainst([]);
        expect(gone.error).toBeInstanceOf(EventsError);
        expect(gone).toMatchObject({ error: { kind: 'notFound', data: { kind: 'event' } }, streams: 1, timers: 0 });

        const pollOnly = await staleCursorAgainst([descriptor('tick', { delivery: ['poll'] })]);
        expect(pollOnly.error).toBeInstanceOf(NoCompatibleDeliveryModeError);
        expect(pollOnly).toMatchObject({ error: { eventName: 'tick', offered: ['poll'], usable: ['push'] }, streams: 1, timers: 0 });
    });

    it('rejects subscribe() with ConnectionClosed when the client closes before the first active', async () => {
        const { client, events, streams } = await pushWith();
        const subscribing = events.subscribe({ name: 'tick', delivery: 'push' }).catch((error_: unknown) => error_);
        await settle();
        expect(streams()).toHaveLength(1);

        await client.close();
        const error = await subscribing;
        expect(error).toBeInstanceOf(SdkError);
        expect(error).toMatchObject({ code: SdkErrorCode.ConnectionClosed });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects subscribe() when the first stream ends before its active, as when none arrives in time', async () => {
        const { events, last, streams } = await pushWith();
        const subscribing = events.subscribe({ name: 'tick', delivery: 'push' }).catch((error_: unknown) => error_);
        await settle();
        await last().end();

        const error = await subscribing;
        expect(error).toBeInstanceOf(SdkError);
        expect(error).toMatchObject({ code: SdkErrorCode.InvalidResult });
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(streams()).toHaveLength(1);
    });

    it('rejects subscribe() when no valid active arrives within the request timeout, and reopens once subscribed', async () => {
        const first = await pushWith();
        let settled = false;
        const subscribing = first.events
            .subscribe({ name: 'tick', delivery: 'push' })
            .catch((error_: unknown) => error_)
            .finally(() => (settled = true));
        await settle();
        await first.last().frame('notifications/events/heartbeat', { cursor: 'c0' });
        await vi.advanceTimersByTimeAsync(59_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const error = await subscribing;
        expect(error).toBeInstanceOf(SdkError);
        expect(error).toMatchObject({ code: SdkErrorCode.RequestTimeout });
        expect(first.notifications).toContainEqual({
            method: 'notifications/cancelled',
            params: expect.objectContaining({ requestId: first.streams()[0]!.call.id })
        });
        expect(vi.getTimerCount()).toBe(0);
        expect(first.streams()).toHaveLength(1);

        const later = await pushWith();
        await later.subscribe();
        await later.last().end();
        await vi.advanceTimersByTimeAsync(500);
        expect(later.streams()).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(60_000 + 1000);
        expect(later.streams()).toHaveLength(3);
    });

    describe('falling back to poll', () => {
        const both = descriptor('tick', { delivery: ['push', 'poll'] });
        const FALLBACK = "events/stream for 'tick' failed before its first notifications/events/active; subscribing by poll instead";

        async function pushOrPoll(stream: Handler) {
            const scripted = await connectEvents({
                'events/list': listing(both),
                'events/stream': stream,
                'events/poll': script({ events: [occurrence('e1')], cursor: 'c1', nextPollMs: 60_000 })
            });
            const errors: Error[] = [];
            scripted.client.onerror = error => void errors.push(error);
            return {
                ...scripted,
                errors,
                streams: () => callsTo(scripted.calls, 'events/stream'),
                polls: () => callsTo(scripted.calls, 'events/poll')
            };
        }

        it.each([
            [
                'no valid active arrives within the request timeout',
                () => new Promise<never>(() => {}),
                { code: SdkErrorCode.RequestTimeout }
            ],
            [
                'the stream fails with an error that is not an Events kind',
                script(new RpcError(-32_603, 'Internal error')),
                { code: -32_603 }
            ],
            ['the stream ends before its first active', script({}), { code: SdkErrorCode.InvalidResult }]
        ])('subscribes by poll when %s, and reports the push failure', async (_case, stream, cause) => {
            const { events, errors, streams, polls } = await pushOrPoll(stream);
            const subscribing = events.subscribe({ name: 'tick', cursor: 'c0' });
            await settle();
            await vi.advanceTimersByTimeAsync(60_000);
            const subscription = await subscribing;
            subscriptions.push(subscription);

            expect(subscription.deliveryMode).toBe('poll');
            expect(await nextEventId(subscription[Symbol.asyncIterator]())).toBe('e1');
            expect(streams()).toHaveLength(1);
            expect(polls()[0]!.params['cursor']).toBe('c0');
            expect(errors).toEqual([expect.objectContaining({ message: FALLBACK, cause: expect.objectContaining(cause) })]);
        });

        it('keeps the maxAgeMs floor subscribe() set when it falls back to poll', async () => {
            const { events, streams, polls } = await pushOrPoll(() => new Promise<never>(() => {}));
            const subscribing = events.subscribe({ name: 'tick', cursor: 'c0', maxAgeMs: 300_000 });
            await settle();
            await vi.advanceTimersByTimeAsync(60_000);
            subscriptions.push(await subscribing);

            // The poll a minute later sends the time since the same floor, not a floor of its own.
            expect(streams()[0]!.params).toMatchObject({ cursor: 'c0', maxAgeMs: 300_000 });
            expect(polls()[0]!.params).toMatchObject({ cursor: 'c0', maxAgeMs: 360_000 });
        });

        it('subscribes by poll when the first active fails its schema, and reports both failures', async () => {
            const { events, errors, send, streams, polls } = await pushOrPoll(() => new Promise<never>(() => {}));
            const subscribing = events.subscribe({ name: 'tick' });
            await settle();
            const meta = { [SUBSCRIPTION_ID_META_KEY]: streams()[0]!.id };
            await send({
                jsonrpc: '2.0',
                method: 'notifications/events/active',
                params: { cursor: null, truncated: false, heartbeatMs: 0, _meta: meta }
            });
            const subscription = await subscribing;
            subscriptions.push(subscription);

            expect(subscription.deliveryMode).toBe('poll');
            expect(await nextEventId(subscription[Symbol.asyncIterator]())).toBe('e1');
            expect(streams()).toHaveLength(1);
            expect(polls()).toHaveLength(1);
            expect(errors).toEqual([
                expect.objectContaining({ message: expect.stringContaining('Invalid notifications/events/active params') }),
                expect.objectContaining({ message: FALLBACK, cause: expect.objectContaining({ code: SdkErrorCode.InvalidResult }) })
            ]);
        });

        it('rejects as before when delivery forces push', async () => {
            const { events, errors, streams, polls } = await pushOrPoll(() => new Promise<never>(() => {}));
            const subscribing = events.subscribe({ name: 'tick', delivery: 'push' }).catch((error_: unknown) => error_);
            await settle();
            await vi.advanceTimersByTimeAsync(60_000);

            const error = await subscribing;
            expect(error).toBeInstanceOf(SdkError);
            expect(error).toMatchObject({ code: SdkErrorCode.RequestTimeout });
            expect(streams()).toHaveLength(1);
            expect(polls()).toHaveLength(0);
            expect(errors).toEqual([]);
        });

        it.each([
            ['an auth failure', authFailure, UnauthorizedError],
            ['a network error of the auth seam', () => markAuthSeamEscape(new TypeError('fetch failed')), TypeError],
            ['-32601', () => new ProtocolError(-32_601, 'Method not found'), ProtocolError]
        ])('rejects without falling back when the first stream fails with %s', async (_case, failure, type) => {
            const { client, events, errors, polls } = await pushOrPoll(() => new Promise<never>(() => {}));
            const attempts = failSends(client, 'events/stream', failure);
            const error = await events.subscribe({ name: 'tick' }).catch((error_: unknown) => error_);

            expect(error).toBeInstanceOf(type);
            expect(polls()).toHaveLength(0);
            expect(errors).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(120_000);
            expect(attempts()).toBe(1);
        });

        it('rejects as before when the first stream is refused with an EventsError', async () => {
            const { events, errors, polls } = await pushOrPoll(script(new RpcError(-32_024, 'Forbidden')));
            const error = await events.subscribe({ name: 'tick' }).catch((error_: unknown) => error_);

            expect(error).toBeInstanceOf(EventsError);
            expect(error).toMatchObject({ kind: 'forbidden' });
            expect(polls()).toHaveLength(0);
            expect(errors).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);
        });
    });

    it('ends the stream on an active that fails its schema: subscribe() rejects, and once subscribed it reopens', async () => {
        const first = await pushWith();
        const errors: Error[] = [];
        first.client.onerror = error => void errors.push(error);
        const subscribing = first.events.subscribe({ name: 'tick', delivery: 'push' }).catch((error_: unknown) => error_);
        await settle();
        await first.last().active({ heartbeatMs: 0 });
        const error = await subscribing;
        expect(error).toBeInstanceOf(SdkError);
        expect(error).toMatchObject({ code: SdkErrorCode.InvalidResult });
        expect(errors).toEqual([
            expect.objectContaining({ message: expect.stringContaining('Invalid notifications/events/active params') })
        ]);
        expect(vi.getTimerCount()).toBe(0);
        expect(first.streams()).toHaveLength(1);

        const later = await pushWith();
        await later.subscribe({}, s => s.active({ cursor: 'c1' }));
        await later.last().end();
        await vi.advanceTimersByTimeAsync(500);
        await later.last().active({ cursor: 'c2', heartbeatMs: 0 });
        expect(later.notifications).toContainEqual({
            method: 'notifications/cancelled',
            params: expect.objectContaining({ requestId: later.streams()[1]!.call.id })
        });
        await vi.advanceTimersByTimeAsync(1000);
        expect(later.streams()).toHaveLength(3);
        expect(later.last().call.params['cursor']).toBe('c1');
    });

    it('ends the loop with ConnectionClosed when the client closes', async () => {
        const { client, streams, subscribe } = await pushWith();
        const sub = await subscribe({}, s => s.active({ heartbeatMs: 5000 }));
        const pending = sub[Symbol.asyncIterator]()
            .next()
            .catch((error_: unknown) => error_);

        await client.close();
        const error = await pending;
        expect(error).toBeInstanceOf(SdkError);
        expect(error).toMatchObject({ code: SdkErrorCode.ConnectionClosed });
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(streams()).toHaveLength(1);
    });

    it('ends the loop with ConnectionClosed when the client reconnects without closing', async () => {
        const { reconnect, streams, subscribe } = await pushWith();
        const sub = await subscribe({}, s => s.active({ cursor: 'c1', heartbeatMs: 5000 }));
        const pending = sub[Symbol.asyncIterator]()
            .next()
            .catch((error_: unknown) => error_);

        await reconnect();
        const error = await pending;
        expect(error).toBeInstanceOf(SdkError);
        expect(error).toMatchObject({ code: SdkErrorCode.ConnectionClosed });
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(streams()).toHaveLength(1);
    });

    it('sends cancellation on cancel()', async () => {
        const { notifications, streams, subscribe } = await pushWith();
        const sub = await subscribe({}, s => s.active({ heartbeatMs: 5000 }));
        const pending = sub[Symbol.asyncIterator]().next();

        await sub.cancel();
        expect(notifications).toContainEqual({
            method: 'notifications/cancelled',
            params: expect.objectContaining({ requestId: streams()[0]!.call.id })
        });
        expect(await pending).toEqual({ done: true, value: undefined });
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(streams()).toHaveLength(1);
    });
});
