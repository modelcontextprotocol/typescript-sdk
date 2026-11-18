import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Client } from '../../../src/client/client';
import type { EventSubscription, SubscribeOptions } from '../../../src/ext/events/index';
import { EventsError, NoCompatibleDeliveryModeError } from '../../../src/ext/events/index';
import type { Call, Handler, Notification } from './scripted';
import { callsTo, connectEvents, descriptor, listing, occurrence, RpcError, script } from './scripted';

const subscriptions: EventSubscription[] = [];

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(async () => {
    await Promise.all(subscriptions.splice(0).map(subscription => subscription.cancel()));
    vi.useRealTimers();
});

/** Lets every in-flight request and its response settle without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

/** The eventId of the loop's next event, `undefined` when the loop is done. */
async function nextEventId(iterator: AsyncIterator<{ eventId: string }>): Promise<string | undefined> {
    const result = await iterator.next();
    return result.done ? undefined : result.value.eventId;
}

async function pollWith(
    poll: Handler,
    list: Handler = listing(descriptor('tick'))
): Promise<{
    client: Client;
    calls: Call[];
    notifications: Notification[];
    polls: () => Call[];
    subscribe: (options?: Partial<SubscribeOptions>) => Promise<EventSubscription>;
}> {
    const { events, client, calls, notifications } = await connectEvents({ 'events/list': list, 'events/poll': poll });
    return {
        client,
        calls,
        notifications,
        polls: () => callsTo(calls, 'events/poll'),
        subscribe: async (options = {}) => {
            const subscription = await events.subscribe({ name: 'tick', delivery: 'poll', ...options });
            subscriptions.push(subscription);
            await settle();
            return subscription;
        }
    };
}

describe('poll delivery', () => {
    it('drains hasMore at once and waits max(nextPollMs, floor) otherwise', async () => {
        const { polls, subscribe } = await pollWith(
            script(
                { events: [occurrence('e1')], cursor: 'c1', hasMore: true, nextPollMs: 30_000 },
                { events: [occurrence('e2')], cursor: 'c2', nextPollMs: 0 },
                { events: [], cursor: 'c3', nextPollMs: 5000 },
                { events: [], cursor: 'c4', nextPollMs: 5000 }
            )
        );
        const sub = await subscribe({ arguments: { severity: 'P1' }, maxAgeMs: 300_000 });

        expect(polls().map(call => call.params)).toEqual([
            expect.objectContaining({ name: 'tick', arguments: { severity: 'P1' }, cursor: null, maxAgeMs: 300_000 }),
            expect.not.objectContaining({ maxAgeMs: expect.anything() })
        ]);
        expect(polls()[1]!.params).toMatchObject({ name: 'tick', arguments: { severity: 'P1' }, cursor: 'c1' });

        await vi.advanceTimersByTimeAsync(999);
        expect(polls()).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(polls()).toHaveLength(3);
        expect(polls()[2]!.params['cursor']).toBe('c2');

        await vi.advanceTimersByTimeAsync(4999);
        expect(polls()).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(1);
        expect(polls()).toHaveLength(4);

        const iterator = sub[Symbol.asyncIterator]();
        expect([await nextEventId(iterator), await nextEventId(iterator)]).toEqual(['e1', 'e2']);
    });

    it('reports truncated through onGap and persists the fresh cursor', async () => {
        const onGap = vi.fn();
        const { polls, subscribe } = await pollWith(script({ events: [], cursor: 'c5', truncated: true, nextPollMs: 60_000 }));
        const sub = await subscribe({ cursor: 'c0', onGap });

        expect(polls()[0]!.params['cursor']).toBe('c0');
        expect(onGap).toHaveBeenCalledExactlyOnceWith('c5');
        expect(sub.cursor).toBe('c5');
    });

    it('moves the cursor past events only once the loop has moved past them', async () => {
        const { subscribe } = await pollWith(script({ events: [occurrence('e1'), occurrence('e2')], cursor: 'c2', nextPollMs: 60_000 }));
        const sub = await subscribe({ cursor: 'c0' });
        const iterator = sub[Symbol.asyncIterator]();

        expect(sub.cursor).toBe('c0');
        await iterator.next();
        expect(sub.cursor).toBe('c0');
        await iterator.next();
        expect(sub.cursor).toBe('c0');
        void iterator.next();
        expect(sub.cursor).toBe('c2');
    });

    it('delivers each eventId once', async () => {
        const { subscribe } = await pollWith(
            script(
                { events: [occurrence('e1')], cursor: 'c1', hasMore: true },
                { events: [occurrence('e1'), occurrence('e2')], cursor: 'c2', nextPollMs: 60_000 }
            )
        );
        const sub = await subscribe();
        const iterator = sub[Symbol.asyncIterator]();
        expect(await nextEventId(iterator)).toBe('e1');
        expect(await nextEventId(iterator)).toBe('e2');

        let settled = false;
        void iterator.next().then(() => (settled = true));
        await settle();
        expect(settled).toBe(false);
    });

    it('keeps cursor null for a non-replayable type', async () => {
        const { polls, subscribe } = await pollWith(
            script({ events: [occurrence('e1')], cursor: null, nextPollMs: 0 }, { events: [], nextPollMs: 60_000 })
        );
        const sub = await subscribe();
        await sub[Symbol.asyncIterator]().next();
        await vi.advanceTimersByTimeAsync(1000);

        expect(polls()).toHaveLength(2);
        expect(polls()[1]!.params).toHaveProperty('cursor', null);
        expect(sub.cursor).toBeNull();
    });

    it('resubscribes after schema_changed and fails on forbidden', async () => {
        const onGap = vi.fn();
        const { calls, polls, subscribe } = await pollWith(
            script(
                { events: [], cursor: 'c1', nextPollMs: 0 },
                new RpcError(-32_026, 'Unsupported', { feature: 'payloadSchema', reason: 'schema_changed' }),
                { events: [occurrence('e1')], cursor: 'c2', nextPollMs: 0 },
                new RpcError(-32_024, 'Forbidden', { reason: 'Access revoked' })
            )
        );
        const sub = await subscribe({ onGap });
        await vi.advanceTimersByTimeAsync(1000);
        expect(polls()).toHaveLength(2);
        expect(callsTo(calls, 'events/list')).toHaveLength(2);

        // This server still accepts the last cursor after the change: no reset, no gap.
        await vi.advanceTimersByTimeAsync(1000);
        expect(polls()).toHaveLength(3);
        expect(polls()[2]!.params['cursor']).toBe('c1');
        expect(onGap).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1000);
        expect(polls()).toHaveLength(4);
        const iterator = sub[Symbol.asyncIterator]();
        expect(await nextEventId(iterator)).toBe('e1');
        const error = await iterator.next().catch((error_: unknown) => error_);
        expect(error).toBeInstanceOf(EventsError);
        expect(error).toMatchObject({ kind: 'forbidden' });
        expect(await iterator.next()).toEqual({ done: true, value: undefined });

        await vi.advanceTimersByTimeAsync(120_000);
        expect(polls()).toHaveLength(4);
    });

    it('starts again from now when the server keeps refusing the last cursor after a schema change', async () => {
        const onGap = vi.fn();
        const schemaChanged = new RpcError(-32_026, 'Unsupported', { feature: 'payloadSchema', reason: 'schema_changed' });
        // Cursors of the old schema epoch ('c…') are refused once the schema has changed; 'v2:…' cursors are the new epoch.
        const { calls, polls, subscribe } = await pollWith(params => {
            if (params['cursor'] === 'c0') return { events: [], cursor: 'c1', nextPollMs: 0 };
            if (params['cursor'] === 'c1') throw schemaChanged;
            if (params['cursor'] === null) return { events: [], cursor: 'v2:0', nextPollMs: 0 };
            return { events: [occurrence('e1')], cursor: 'v2:1', nextPollMs: 60_000 };
        });
        const sub = await subscribe({ cursor: 'c0', onGap });
        await vi.advanceTimersByTimeAsync(10_000);

        expect(polls().map(call => call.params['cursor'])).toEqual(['c0', 'c1', 'c1', null, 'v2:0']);
        expect(callsTo(calls, 'events/list')).toHaveLength(3);
        expect(onGap).toHaveBeenCalledExactlyOnceWith('v2:0');
        expect(await nextEventId(sub[Symbol.asyncIterator]())).toBe('e1');
        expect(sub.cursor).toBe('v2:0');
    });

    it('ends the loop with notFound once the event type is no longer listed', async () => {
        const lists = [[descriptor('tick')], []];
        const { calls, subscribe } = await pollWith(
            script({ events: [], cursor: 'c1', nextPollMs: 0 }, new RpcError(-32_023, 'Not found', { kind: 'event' })),
            () => ({ events: lists.shift() ?? [] })
        );
        const sub = await subscribe();
        const pending = sub[Symbol.asyncIterator]()
            .next()
            .catch((error_: unknown) => error_);
        await vi.advanceTimersByTimeAsync(1000);

        const error = await pending;
        expect(error).toBeInstanceOf(EventsError);
        expect(error).toMatchObject({ kind: 'notFound', data: { kind: 'event' } });
        expect(callsTo(calls, 'events/list')).toHaveLength(2);
    });

    it('retries other errors after max(floor, nextPollMs), doubling to 60 s', async () => {
        const failures = Array.from({ length: 9 }, () => new RpcError(-32_603, 'Internal error'));
        const { polls, subscribe } = await pollWith(
            script({ events: [], cursor: 'c1', nextPollMs: 2000 }, ...failures, { events: [occurrence('e1')], cursor: 'c2', nextPollMs: 0 })
        );
        const sub = await subscribe();

        for (const delay of [2000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000]) {
            const before = polls().length;
            await vi.advanceTimersByTimeAsync(delay - 1);
            expect(polls()).toHaveLength(before);
            await vi.advanceTimersByTimeAsync(1);
            expect(polls()).toHaveLength(before + 1);
        }
        expect(polls()[0]!.params['cursor']).toBeNull();
        expect(
            polls()
                .slice(1)
                .every(call => call.params['cursor'] === 'c1')
        ).toBe(true);
        expect(await nextEventId(sub[Symbol.asyncIterator]())).toBe('e1');
    });

    it('rejects subscribe() when the first poll is refused, leaving nothing running', async () => {
        const refusals = [
            new RpcError(-32_023, 'Not found', { kind: 'event' }),
            new RpcError(-32_602, 'Invalid arguments'),
            new RpcError(-32_024, 'Forbidden'),
            new RpcError(-32_026, 'Unsupported', { feature: 'deliveryMode', value: 'poll' }),
            // Without a cursor there is no stale one to drop, so a schema change refuses too.
            new RpcError(-32_026, 'Unsupported', { feature: 'payloadSchema', reason: 'schema_changed' })
        ];
        for (const refusal of refusals) {
            const { calls, polls, subscribe } = await pollWith(script(refusal));
            const error = await subscribe().catch((error_: unknown) => error_);
            expect(error).toBeInstanceOf(EventsError);
            expect(error).toMatchObject({ code: refusal.code });

            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(120_000);
            expect(polls()).toHaveLength(1);
            expect(callsTo(calls, 'events/list')).toHaveLength(1);
        }
    });

    it('rejects subscribe() when the first poll fails in the SDK', async () => {
        const { polls, subscribe } = await pollWith(script({ events: 'not an array' }));
        const error = await subscribe().catch((error_: unknown) => error_);
        expect(error).toBeInstanceOf(SdkError);
        expect(error).toMatchObject({ code: SdkErrorCode.InvalidResult });
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(polls()).toHaveLength(1);
    });

    it('resolves subscribe() after a transient first-poll failure and delivers after the retry', async () => {
        const { polls, subscribe } = await pollWith(
            script(new RpcError(-32_603, 'Internal error'), { events: [occurrence('e1')], cursor: 'c1', nextPollMs: 60_000 })
        );
        const sub = await subscribe();
        expect(polls()).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1000);
        expect(polls()).toHaveLength(2);
        expect(await nextEventId(sub[Symbol.asyncIterator]())).toBe('e1');
    });

    it('ends the loop with ConnectionClosed when the client closes during a poll', async () => {
        const { client, polls, subscribe } = await pollWith(script({ events: [], cursor: 'c1', nextPollMs: 0 }));
        const sub = await subscribe();
        await vi.advanceTimersByTimeAsync(1000);
        expect(polls()).toHaveLength(2);
        const pending = sub[Symbol.asyncIterator]()
            .next()
            .catch((error_: unknown) => error_);

        await client.close();
        const error = await pending;
        expect(error).toBeInstanceOf(SdkError);
        expect(error).toMatchObject({ code: SdkErrorCode.ConnectionClosed });
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(polls()).toHaveLength(2);
    });

    it('ends the loop with ConnectionClosed when the client closes during a backoff wait', async () => {
        const { client, polls, subscribe } = await pollWith(
            script({ events: [], cursor: 'c1', nextPollMs: 0 }, new RpcError(-32_603, 'Internal error'), { events: [], cursor: 'c2' })
        );
        const sub = await subscribe();
        await vi.advanceTimersByTimeAsync(1000);
        expect(polls()).toHaveLength(2);
        const pending = sub[Symbol.asyncIterator]()
            .next()
            .catch((error_: unknown) => error_);

        await client.close();
        const error = await pending;
        expect(error).toBeInstanceOf(SdkError);
        expect(error).toMatchObject({ code: SdkErrorCode.ConnectionClosed });
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(polls()).toHaveLength(2);
    });

    it('ends the loop with ConnectionClosed at once when the client closes during a long nextPollMs wait', async () => {
        const { client, polls, subscribe } = await pollWith(script({ events: [], cursor: 'c1', nextPollMs: 600_000 }));
        const sub = await subscribe();
        expect(polls()).toHaveLength(1);
        const pending = sub[Symbol.asyncIterator]()
            .next()
            .catch((error_: unknown) => error_);

        await client.close();
        const error = await pending;
        expect(error).toBeInstanceOf(SdkError);
        expect(error).toMatchObject({ code: SdkErrorCode.ConnectionClosed });
        expect(vi.getTimerCount()).toBe(0);
        expect(polls()).toHaveLength(1);
    });

    it('rejects subscribe() with ConnectionClosed when the client closes before the first poll answers', async () => {
        const { client, polls, subscribe } = await pollWith(script());
        const subscribing = subscribe().catch((error_: unknown) => error_);
        await settle();
        expect(polls()).toHaveLength(1);

        await client.close();
        const error = await subscribing;
        expect(error).toBeInstanceOf(SdkError);
        expect(error).toMatchObject({ code: SdkErrorCode.ConnectionClosed });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('drops a stale cursor that the first poll refuses for a schema change, and starts from now', async () => {
        const onGap = vi.fn();
        const { calls, polls, subscribe } = await pollWith(params => {
            if (params['cursor'] === 'stale')
                throw new RpcError(-32_026, 'Unsupported', { feature: 'inputSchema', reason: 'schema_changed' });
            if (params['cursor'] === null) return { events: [], cursor: 'v2:0', nextPollMs: 0 };
            return { events: [occurrence('e1')], cursor: 'v2:1', nextPollMs: 60_000 };
        });
        const sub = await subscribe({ cursor: 'stale', onGap });

        expect(polls().map(call => call.params['cursor'])).toEqual(['stale', null]);
        expect(callsTo(calls, 'events/list')).toHaveLength(2);
        expect(onGap).toHaveBeenCalledExactlyOnceWith('v2:0');
        expect(sub.cursor).toBe('v2:0');
        await vi.advanceTimersByTimeAsync(1000);
        expect(await nextEventId(sub[Symbol.asyncIterator]())).toBe('e1');
        expect(onGap).toHaveBeenCalledOnce();
    });

    it('rejects subscribe() after a schema change refuses its cursor when the type is gone or no longer polled', async () => {
        // The first poll refuses the stale cursor; the re-list that follows returns `relisted`.
        const staleCursorAgainst = async (relisted: ReturnType<typeof descriptor>[]) => {
            const lists = [[descriptor('tick')], relisted];
            const schemaChanged = new RpcError(-32_026, 'Unsupported', { feature: 'payloadSchema', reason: 'schema_changed' });
            const { polls, subscribe } = await pollWith(script(schemaChanged), () => ({ events: lists.shift() ?? relisted }));
            const error = await subscribe({ cursor: 'stale' }).catch((error_: unknown) => error_);
            return { error, polls: polls().length, timers: vi.getTimerCount() };
        };

        const gone = await staleCursorAgainst([]);
        expect(gone.error).toBeInstanceOf(EventsError);
        expect(gone).toMatchObject({ error: { kind: 'notFound', data: { kind: 'event' } }, polls: 1, timers: 0 });

        const pushOnly = await staleCursorAgainst([descriptor('tick', { delivery: ['push'] })]);
        expect(pushOnly.error).toBeInstanceOf(NoCompatibleDeliveryModeError);
        expect(pushOnly).toMatchObject({ error: { eventName: 'tick', offered: ['push'], usable: ['poll'] }, polls: 1, timers: 0 });
    });

    it('stops polling on cancel()', async () => {
        const { polls, subscribe } = await pollWith(script({ events: [], cursor: 'c1', nextPollMs: 0 }));
        const sub = await subscribe();
        expect(polls()).toHaveLength(1);
        const pending = sub[Symbol.asyncIterator]().next();

        await sub.cancel();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(polls()).toHaveLength(1);
        expect(await pending).toEqual({ done: true, value: undefined });
    });

    it('stops polling when the loop breaks, and aborts a poll in flight', async () => {
        const { notifications, polls, subscribe } = await pollWith(script({ events: [occurrence('e1')], cursor: 'c1', nextPollMs: 0 }));
        const sub = await subscribe();
        await vi.advanceTimersByTimeAsync(1000);
        expect(polls()).toHaveLength(2);

        for await (const event of sub) {
            expect(event.eventId).toBe('e1');
            break;
        }
        await vi.advanceTimersByTimeAsync(10_000);
        expect(polls()).toHaveLength(2);
        expect(notifications).toContainEqual({
            method: 'notifications/cancelled',
            params: expect.objectContaining({ requestId: polls()[1]!.id })
        });
    });
});
