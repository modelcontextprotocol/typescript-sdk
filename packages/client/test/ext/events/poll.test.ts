import { ProtocolError, SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/core-internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UnauthorizedError } from '../../../src/client/auth';
import type { Client } from '../../../src/client/client';
import type { EventSubscription, SubscribeOptions } from '../../../src/ext/events/index';
import { EventsError, NoCompatibleDeliveryModeError } from '../../../src/ext/events/index';
import type { Call, Handler, Notification } from './scripted';
import { authFailure, callsTo, connectEvents, descriptor, failSends, listing, occurrence, RpcError, script } from './scripted';

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
    reconnect: () => Promise<void>;
    polls: () => Call[];
    subscribe: (options?: Partial<SubscribeOptions>) => Promise<EventSubscription>;
}> {
    const { events, client, calls, notifications, reconnect } = await connectEvents({ 'events/list': list, 'events/poll': poll });
    return {
        client,
        calls,
        notifications,
        reconnect,
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
        // Without a cursor the subscription starts from now, so maxAgeMs is never sent.
        const sub = await subscribe({ arguments: { severity: 'P1' }, maxAgeMs: 300_000 });

        expect(polls().map(call => call.params)).toEqual([
            expect.objectContaining({ name: 'tick', arguments: { severity: 'P1' }, cursor: null }),
            expect.not.objectContaining({ maxAgeMs: expect.anything() })
        ]);
        expect(polls()[0]!.params).not.toHaveProperty('maxAgeMs');
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

    it('polls again after the floor on a truncated hasMore page without events, and at once on hasMore with events', async () => {
        // As two replicas with their own emit buffers answer a cursor the other one gave.
        const { polls, subscribe } = await pollWith(
            script(
                { events: [], cursor: 'b0', truncated: true, hasMore: true, nextPollMs: 0 },
                { events: [], cursor: 'a0', truncated: true, hasMore: true, nextPollMs: 0 },
                { events: [occurrence('e1')], cursor: 'a1', hasMore: true, nextPollMs: 0 },
                { events: [occurrence('e2')], cursor: 'a2', nextPollMs: 60_000 }
            )
        );
        await subscribe();
        expect(polls()).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(999);
        expect(polls()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(polls()).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(999);
        expect(polls()).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(polls().map(call => call.params['cursor'])).toEqual([null, 'b0', 'a0', 'a1']);
    });

    it('polls again at once on hasMore pages without events whose cursor advanced, and after the floor on one that kept the cursor', async () => {
        // As a check that filters each page of its upstream for this subscription.
        const { polls, subscribe } = await pollWith(
            script(
                { events: [], cursor: 'c1', hasMore: true, nextPollMs: 0 },
                { events: [], cursor: 'c2', hasMore: true, nextPollMs: 0 },
                { events: [], cursor: 'c2', hasMore: true, nextPollMs: 0 },
                { events: [occurrence('e1')], cursor: 'c3', nextPollMs: 60_000 }
            )
        );
        await subscribe({ cursor: 'c0' });
        expect(polls().map(call => call.params['cursor'])).toEqual(['c0', 'c1', 'c2']);

        await vi.advanceTimersByTimeAsync(999);
        expect(polls()).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(1);
        expect(polls().map(call => call.params['cursor'])).toEqual(['c0', 'c1', 'c2', 'c2']);
    });

    it('sends maxAgeMs on every poll of a subscription that started from a cursor, grown by the time since subscribe()', async () => {
        const { polls, subscribe } = await pollWith(
            script(
                { events: [], cursor: 'c1', truncated: true, hasMore: true, nextPollMs: 0 },
                { events: [occurrence('e1')], cursor: 'c2', hasMore: true, nextPollMs: 0 },
                { events: [], cursor: 'c3', nextPollMs: 0 },
                { events: [], cursor: 'c3', nextPollMs: 60_000 }
            )
        );
        await subscribe({ cursor: 'c0', maxAgeMs: 300_000 });
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(1000);
        // A paging replay keeps the floor on page 2 and later, and so does every poll after it.
        expect(polls().map(call => [call.params['cursor'], call.params['maxAgeMs']])).toEqual([
            ['c0', 300_000],
            ['c1', 301_000],
            ['c2', 301_000],
            ['c3', 302_000]
        ]);
    });

    it('sends no poll while 1 000 events wait for the loop, and polls again once the loop has taken half of them, losing and repeating none', async () => {
        let produced = 0;
        const { polls, subscribe } = await pollWith(() => {
            const events = Array.from({ length: 100 }, () => occurrence(`e${produced++}`));
            return { events, cursor: `c${produced}`, hasMore: true, nextPollMs: 0 };
        });
        const sub = await subscribe();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(polls()).toHaveLength(10);

        const iterator = sub[Symbol.asyncIterator]();
        const ids: string[] = [];
        while (ids.length < 499) ids.push((await nextEventId(iterator))!);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(polls()).toHaveLength(10);
        // The 500th event the loop takes leaves 500 waiting: polling resumes, until the pages fill the queue again.
        ids.push((await nextEventId(iterator))!);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(polls()).toHaveLength(15);
        expect(polls()[10]!.params['cursor']).toBe('c1000');

        while (ids.length < 1500) ids.push((await nextEventId(iterator))!);
        expect(ids).toEqual(Array.from({ length: 1500 }, (_, n) => `e${n}`));
    });

    it('reports onGap(null) once per pause of a type without replay, as the server may lose its events while no poll goes out', async () => {
        const onGap = vi.fn();
        let produced = 0;
        const { polls, subscribe } = await pollWith(() => {
            const events = Array.from({ length: 100 }, () => occurrence(`e${produced++}`));
            return { events, cursor: null, hasMore: true, nextPollMs: 0 };
        });
        const sub = await subscribe({ onGap });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(polls()).toHaveLength(10);
        expect(onGap).toHaveBeenCalledExactlyOnceWith(null);

        const iterator = sub[Symbol.asyncIterator]();
        for (let taken = 0; taken < 499; taken++) await iterator.next();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(onGap).toHaveBeenCalledOnce();
        // Taking the 500th ends the pause; the pages fill the queue again, and the next pause reports again.
        await iterator.next();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(polls()).toHaveLength(15);
        expect(onGap.mock.calls).toEqual([[null], [null]]);
        expect(sub.cursor).toBeNull();
    });

    it('reports one gap for a run of truncated results, and another for a truncated result after a clean one', async () => {
        const onGap = vi.fn();
        const pages = Array.from({ length: 10 }, (_, n) => ({
            events: [occurrence(`e${n + 1}`)],
            cursor: `c${n + 1}`,
            truncated: true,
            hasMore: true,
            nextPollMs: 0
        }));
        const { polls, subscribe } = await pollWith(
            script(
                ...pages,
                { events: [], cursor: 'c10', nextPollMs: 0 },
                { events: [], cursor: 'c11', truncated: true, nextPollMs: 60_000 }
            )
        );
        await subscribe({ cursor: 'c0', onGap });
        expect(polls()).toHaveLength(11);
        expect(onGap).toHaveBeenCalledExactlyOnceWith('c1');

        await vi.advanceTimersByTimeAsync(1000);
        expect(polls()).toHaveLength(12);
        expect(onGap).toHaveBeenCalledTimes(2);
        expect(onGap).toHaveBeenLastCalledWith('c11');
    });

    it('reports a gap for each truncated result without hasMore, as each is a separate loss', async () => {
        const onGap = vi.fn();
        // As a check over an upstream with bounded retention that lost entries again since the last poll.
        const { polls, subscribe } = await pollWith(
            script(
                { events: [occurrence('e1')], cursor: 'c1', truncated: true, nextPollMs: 30_000 },
                { events: [occurrence('e2')], cursor: 'c2', truncated: true, nextPollMs: 30_000 },
                { events: [occurrence('e3')], cursor: 'c3', truncated: true, hasMore: true, nextPollMs: 0 },
                { events: [occurrence('e4')], cursor: 'c4', truncated: true, nextPollMs: 60_000 }
            )
        );
        await subscribe({ cursor: 'c0', onGap });
        expect(onGap).toHaveBeenCalledExactlyOnceWith('c1');

        await vi.advanceTimersByTimeAsync(30_000);
        expect(polls()).toHaveLength(2);
        expect(onGap.mock.calls).toEqual([['c1'], ['c2']]);

        // The third starts a run of truncated hasMore pages, which the fourth continues.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(polls()).toHaveLength(4);
        expect(onGap.mock.calls).toEqual([['c1'], ['c2'], ['c3']]);
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

    it('ends the loop on a second notFound in a row while the event type is still listed, after reporting the first as retried', async () => {
        const notFound = new RpcError(-32_023, 'Not found', { kind: 'subscription' });
        let polled = 0;
        const { client, calls, polls, subscribe } = await pollWith(() => {
            polled += 1;
            if (polled === 1) return { events: [], cursor: 'c1', nextPollMs: 0 };
            throw notFound;
        });
        const errors: Error[] = [];
        client.onerror = error => void errors.push(error);
        const sub = await subscribe();
        const pending = sub[Symbol.asyncIterator]()
            .next()
            .catch((error_: unknown) => error_);

        await vi.advanceTimersByTimeAsync(1000);
        expect(polls()).toHaveLength(2);
        expect(errors).toEqual([
            expect.objectContaining({
                message: "poll subscription to 'tick' failed and is retried: Not found",
                cause: expect.objectContaining({ kind: 'notFound' })
            })
        ]);
        await vi.advanceTimersByTimeAsync(1000);
        const error = await pending;
        expect(error).toBeInstanceOf(EventsError);
        expect(error).toMatchObject({ kind: 'notFound', data: { kind: 'subscription' } });
        expect(polls()).toHaveLength(3);
        expect(callsTo(calls, 'events/list')).toHaveLength(3);
        expect(errors).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('carries on after a notFound while the event type is still listed once a poll succeeds between them', async () => {
        const notFound = new RpcError(-32_023, 'Not found', { kind: 'subscription' });
        const { polls, subscribe } = await pollWith(
            script(
                { events: [], cursor: 'c1', nextPollMs: 0 },
                notFound,
                { events: [occurrence('e1')], cursor: 'c2', nextPollMs: 0 },
                notFound,
                { events: [occurrence('e2')], cursor: 'c3', nextPollMs: 60_000 }
            )
        );
        const sub = await subscribe();
        await vi.advanceTimersByTimeAsync(4000);
        expect(polls().map(call => call.params['cursor'])).toEqual([null, 'c1', 'c1', 'c2', 'c2']);
        const iterator = sub[Symbol.asyncIterator]();
        expect([await nextEventId(iterator), await nextEventId(iterator)]).toEqual(['e1', 'e2']);
    });

    it('ends the loop on an HTTP 404 whose body is a -32601, and retries a 404 without one', async () => {
        const notFoundBody = (body: string) =>
            new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, `Error POSTing to endpoint: ${body}`, {
                status: 404,
                statusText: 'Not Found',
                text: body
            });
        const methodNotFound = JSON.stringify({ jsonrpc: '2.0', id: 3, error: { code: -32_601, message: 'Method not found' } });
        const other = JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32_603, message: 'Internal error' } });
        const { client, polls, subscribe } = await pollWith(
            script({ events: [], cursor: 'c1', nextPollMs: 0 }, { events: [occurrence('e1')], cursor: 'c2', nextPollMs: 0 })
        );
        // The second poll gets a plain 404, the third one whose body is another JSON-RPC error; the fourth goes through, and the fifth gets a -32601.
        const failures: Array<SdkHttpError | undefined> = [undefined, notFoundBody('Not Found'), notFoundBody(other), undefined];
        const attempts = failSends(client, 'events/poll', attempt =>
            attempt <= failures.length ? failures[attempt - 1] : notFoundBody(methodNotFound)
        );
        const sub = await subscribe();
        const iterator = sub[Symbol.asyncIterator]();
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(2000);
        expect(await nextEventId(iterator)).toBe('e1');
        expect(polls()).toHaveLength(2);

        const pending = iterator.next().catch((error_: unknown) => error_);
        await vi.advanceTimersByTimeAsync(1000);
        const error = await pending;
        expect(error).toBeInstanceOf(SdkHttpError);
        expect(error).toMatchObject({ status: 404, data: { text: methodNotFound } });
        expect(attempts()).toBe(5);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('ends the loop on resourceExhausted, callbackEndpointError and an unsupported that is not a schema change', async () => {
        for (const refusal of [
            new RpcError(-32_025, 'Too many subscriptions', { limit: 'subscriptions' }),
            new RpcError(-32_027, 'Callback endpoint error', { reason: 'timeout' }),
            new RpcError(-32_026, 'Unsupported', { feature: 'deliveryMode', value: 'poll' })
        ]) {
            const { calls, polls, subscribe } = await pollWith(script({ events: [], cursor: 'c1', nextPollMs: 0 }, refusal));
            const sub = await subscribe();
            const pending = sub[Symbol.asyncIterator]()
                .next()
                .catch((error_: unknown) => error_);
            await vi.advanceTimersByTimeAsync(1000);

            const error = await pending;
            expect(error).toBeInstanceOf(EventsError);
            expect(error).toMatchObject({ code: refusal.code });
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(120_000);
            expect(polls()).toHaveLength(2);
            expect(callsTo(calls, 'events/list')).toHaveLength(1);
        }
    });

    it('ends the loop on a second -32020 after the re-list', async () => {
        const mismatch = new RpcError(-32_020, 'Mcp-Param-Region header mismatch');
        const { calls, polls, subscribe } = await pollWith(script({ events: [], cursor: 'c1', nextPollMs: 0 }, mismatch, mismatch));
        const sub = await subscribe();
        const pending = sub[Symbol.asyncIterator]()
            .next()
            .catch((error_: unknown) => error_);
        await vi.advanceTimersByTimeAsync(1000);

        const error = await pending;
        expect(error).toBeInstanceOf(ProtocolError);
        expect(error).toMatchObject({ code: -32_020 });
        expect(polls()).toHaveLength(3);
        expect(callsTo(calls, 'events/list')).toHaveLength(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects subscribe() when the first poll mismatches Mcp-Param headers again after a re-list', async () => {
        const mismatch = new RpcError(-32_020, 'Mcp-Param-Region header mismatch');
        const { calls, polls, subscribe } = await pollWith(script(mismatch, mismatch));
        const error = await subscribe().catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(ProtocolError);
        expect(error).toMatchObject({ code: -32_020 });
        expect(polls()).toHaveLength(2);
        expect(callsTo(calls, 'events/list')).toHaveLength(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('reports a throwing onGap to onerror and keeps polling', async () => {
        const failure = new Error('onGap failed');
        const { client, polls, subscribe } = await pollWith(
            script(
                { events: [], cursor: 'c5', truncated: true, nextPollMs: 0 },
                { events: [occurrence('e1')], cursor: 'c6', nextPollMs: 60_000 }
            )
        );
        const errors: Error[] = [];
        client.onerror = error => void errors.push(error);
        const sub = await subscribe({
            cursor: 'c0',
            onGap: () => {
                throw failure;
            }
        });

        expect(errors).toEqual([failure]);
        expect(sub.cursor).toBe('c5');
        await vi.advanceTimersByTimeAsync(1000);
        expect(polls()).toHaveLength(2);
        expect(await nextEventId(sub[Symbol.asyncIterator]())).toBe('e1');
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
            // A refused delivery mode lists the event types again, which still select it.
            expect(callsTo(calls, 'events/list')).toHaveLength(refusal.data?.['feature'] === 'deliveryMode' ? 2 : 1);
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

    it('reports a retried failure to onerror at once, then those of the next minute together, and keeps polling', async () => {
        const { client, polls, subscribe } = await pollWith(() => {
            throw new RpcError(-32_603, 'Internal error');
        });
        const errors: Error[] = [];
        client.onerror = error => void errors.push(error);
        await subscribe();

        expect(errors).toEqual([
            expect.objectContaining({
                message: "poll subscription to 'tick' failed and is retried: Internal error",
                cause: expect.objectContaining({ code: -32_603 })
            })
        ]);
        // Retries at 1, 3, 7, 15 and 31 s fall in the minute after that report.
        await vi.advanceTimersByTimeAsync(59_999);
        expect(polls()).toHaveLength(6);
        expect(errors).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(errors).toHaveLength(2);
        expect(errors[1]).toMatchObject({
            message: "poll subscription to 'tick': 5 more retried failures since the last report, the latest: Internal error",
            cause: expect.objectContaining({ code: -32_603 })
        });
        await vi.advanceTimersByTimeAsync(120_000);
        expect(polls()).toHaveLength(8);
        expect(errors).toHaveLength(4);
    });

    it('ends the loop on -32601, and rejects subscribe() when the first poll gets it', async () => {
        const { polls, subscribe } = await pollWith(
            script({ events: [], cursor: 'c1', nextPollMs: 0 }, new RpcError(-32_601, 'Method not found'))
        );
        const sub = await subscribe();
        const pending = sub[Symbol.asyncIterator]()
            .next()
            .catch((error_: unknown) => error_);
        await vi.advanceTimersByTimeAsync(1000);

        const error = await pending;
        expect(error).toBeInstanceOf(ProtocolError);
        expect(error).toMatchObject({ code: -32_601 });
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(polls()).toHaveLength(2);

        const first = await pollWith(script(new RpcError(-32_601, 'Method not found')));
        const refused = await first.subscribe().catch((error_: unknown) => error_);
        expect(refused).toBeInstanceOf(ProtocolError);
        expect(refused).toMatchObject({ code: -32_601 });
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(first.polls()).toHaveLength(1);
    });

    it('rejects subscribe() on an auth failure of the first poll, and ends the loop on one once subscribed, without retrying', async () => {
        const first = await pollWith(script({ events: [], cursor: 'c1', nextPollMs: 60_000 }));
        const refusedPolls = failSends(first.client, 'events/poll', authFailure);
        const error = await first.subscribe().catch((error_: unknown) => error_);
        expect(error).toBeInstanceOf(UnauthorizedError);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(refusedPolls()).toBe(1);

        const later = await pollWith(script({ events: [], cursor: 'c1', nextPollMs: 0 }));
        const sub = await later.subscribe();
        const laterPolls = failSends(later.client, 'events/poll', authFailure);
        const pending = sub[Symbol.asyncIterator]()
            .next()
            .catch((error_: unknown) => error_);
        await vi.advanceTimersByTimeAsync(1000);
        expect(await pending).toBeInstanceOf(UnauthorizedError);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(laterPolls()).toBe(1);
        expect(later.polls()).toHaveLength(1);
    });

    it('resolves subscribe() after an HTTP 503 or 429 on the first poll and delivers after the retry; another status rejects', async () => {
        const httpError = (status: number) =>
            new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, `Error POSTing to endpoint: ${status}`, { status });
        for (const status of [503, 429]) {
            const { client, polls, subscribe } = await pollWith(script({ events: [occurrence('e1')], cursor: 'c1', nextPollMs: 60_000 }));
            failSends(client, 'events/poll', attempt => (attempt === 1 ? httpError(status) : undefined));
            const sub = await subscribe();
            expect(polls()).toHaveLength(0);

            await vi.advanceTimersByTimeAsync(1000);
            expect(polls()).toHaveLength(1);
            expect(await nextEventId(sub[Symbol.asyncIterator]())).toBe('e1');
            await sub.cancel();
        }

        const { client, subscribe } = await pollWith(script({ events: [], cursor: 'c1', nextPollMs: 60_000 }));
        const attempts = failSends(client, 'events/poll', () => httpError(404));
        const error = await subscribe().catch((error_: unknown) => error_);
        expect(error).toBeInstanceOf(SdkHttpError);
        expect(error).toMatchObject({ status: 404 });
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(attempts()).toBe(1);
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

    it('ends the loop with ConnectionClosed when the client reconnects without closing', async () => {
        const { polls, reconnect, subscribe } = await pollWith(script({ events: [], cursor: 'c1', nextPollMs: 600_000 }));
        const sub = await subscribe();
        const pending = sub[Symbol.asyncIterator]()
            .next()
            .catch((error_: unknown) => error_);

        await reconnect();
        const error = await pending;
        expect(error).toBeInstanceOf(SdkError);
        expect(error).toMatchObject({ code: SdkErrorCode.ConnectionClosed });
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(600_000);
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

    it('resolves subscribe() when the re-list after a refused stale cursor fails transiently, and starts from now in the background', async () => {
        const onGap = vi.fn();
        let lists = 0;
        const list: Handler = () => {
            lists += 1;
            if (lists === 2) throw new RpcError(-32_603, 'Internal error');
            return { events: [descriptor('tick')] };
        };
        const { polls, subscribe } = await pollWith(params => {
            if (params['cursor'] === 'stale')
                throw new RpcError(-32_026, 'Unsupported', { feature: 'inputSchema', reason: 'schema_changed' });
            return { events: [], cursor: 'v2:0', nextPollMs: 60_000 };
        }, list);
        const sub = await subscribe({ cursor: 'stale', onGap });

        expect(polls().map(call => call.params['cursor'])).toEqual(['stale']);
        expect(lists).toBe(2);
        await vi.advanceTimersByTimeAsync(1000);
        expect(polls().map(call => call.params['cursor'])).toEqual(['stale', null]);
        expect(onGap).toHaveBeenCalledExactlyOnceWith('v2:0');
        expect(sub.cursor).toBe('v2:0');
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
