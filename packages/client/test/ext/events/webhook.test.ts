import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal';
import { generateWebhookSecret, parseWebhookSecret } from '@modelcontextprotocol/core-internal/ext/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UnauthorizedError } from '../../../src/client/auth';
import type { EventSubscription, SubscribeOptions } from '../../../src/ext/events/index';
import { EventsError, NoCompatibleDeliveryModeError } from '../../../src/ext/events/index';
import type { Call, Handler } from './scripted';
import {
    authFailure,
    callsTo,
    connectEvents,
    descriptor,
    failSends,
    listing,
    occurrence,
    RpcError,
    WEBHOOK_URL,
    webhookPost
} from './scripted';

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

const tick = descriptor('tick', { delivery: ['webhook'] });
const schemaChange = { feature: 'payloadSchema', reason: 'schema_changed' };

const secretOf = (call: Call): string => (call.params['delivery'] as { secret: string }).secret;

/** A grant of 60 s from now for `sub_1`, merged with `overrides`. */
function grant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { id: 'sub_1', refreshBefore: new Date(Date.now() + 60_000).toISOString(), cursor: null, truncated: false, ...overrides };
}

/** Answers each `events/subscribe` with a grant merged with the next answer, or throws it; once they run out, never answers. */
function granting(...answers: Array<Record<string, unknown> | RpcError>): Handler {
    return () => {
        const next = answers.shift();
        if (next === undefined) return new Promise<never>(() => {});
        if (next instanceof RpcError) throw next;
        return grant(next);
    };
}

async function webhookWith(
    subscribe: Handler,
    options: { list?: Handler; unsubscribe?: Handler; secretProvider?: () => string; pollIntervalFloorMs?: number } = {}
) {
    const { secretProvider, pollIntervalFloorMs } = options;
    const scripted = await connectEvents(
        {
            'events/list': options.list ?? listing(tick),
            'events/subscribe': subscribe,
            'events/unsubscribe': options.unsubscribe ?? (() => ({}))
        },
        {
            events: {
                webhook: { url: WEBHOOK_URL, ...(secretProvider !== undefined && { secretProvider }) },
                ...(pollIntervalFloorMs !== undefined && { pollIntervalFloorMs })
            }
        }
    );
    const handler = scripted.events.createWebhookHandler();
    const subscribes = () => callsTo(scripted.calls, 'events/subscribe');
    return {
        ...scripted,
        handler,
        subscribes,
        lists: () => callsTo(scripted.calls, 'events/list'),
        unsubscribes: () => callsTo(scripted.calls, 'events/unsubscribe'),
        /** POSTs `body` to the receiver as the server does (for `sub_1`, signed with the secret of the last `events/subscribe`); resolves with the status. */
        post: async (body: unknown, id = 'sub_1') => {
            const response = await handler(await webhookPost(body, secretOf(subscribes().at(-1)!), id));
            return response.status;
        },
        subscribe: async (options: Partial<SubscribeOptions> = {}) => {
            const subscription = await scripted.events.subscribe({ name: 'tick', ...options });
            subscriptions.push(subscription);
            await settle();
            return subscription;
        }
    };
}

/** A webhook client whose `events/unsubscribe` answers wait until the test gives them, and come at once after `answerAll()`. */
async function heldUnsubscribe() {
    const held: Array<(answer: Record<string, unknown> | RpcError) => void> = [];
    let holding = true;
    const scripted = await webhookWith(granting({}, {}), {
        unsubscribe: () =>
            holding
                ? new Promise((resolve, reject) => held.push(answer => (answer instanceof RpcError ? reject(answer) : resolve(answer))))
                : {}
    });
    const unsubscribe = {
        answer: (answer: Record<string, unknown> | RpcError) => held.shift()!(answer),
        answerAll: () => {
            holding = false;
            for (const answer of held.splice(0)) answer({});
        }
    };
    return { ...scripted, unsubscribe };
}

describe('webhook delivery', () => {
    it('subscribes with a generated whsec_ secret and refreshes at ¾ of the grant', async () => {
        const { subscribes, subscribe } = await webhookWith(granting({ cursor: 'c1' }, { cursor: 'c2' }, { id: 'sub_2' }));
        const sub = await subscribe({ arguments: { severity: 'P1' }, maxAgeMs: 300_000 });

        expect(sub.deliveryMode).toBe('webhook');
        const first = subscribes()[0]!;
        expect(first.params).toEqual({
            name: 'tick',
            arguments: { severity: 'P1' },
            delivery: { mode: 'webhook', url: WEBHOOK_URL, secret: expect.stringMatching(/^whsec_/) },
            cursor: null,
            maxAgeMs: 300_000,
            _meta: expect.any(Object)
        });
        expect(parseWebhookSecret(secretOf(first))).toHaveLength(32);
        expect(sub.cursor).toBe('c1');

        await vi.advanceTimersByTimeAsync(44_999);
        expect(subscribes()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(subscribes()).toHaveLength(2);
        expect(subscribes()[1]!.params).toEqual({
            name: 'tick',
            arguments: { severity: 'P1' },
            delivery: { mode: 'webhook', url: WEBHOOK_URL, secret: secretOf(first) },
            cursor: 'c1',
            _meta: expect.any(Object)
        });
        expect(sub.cursor).toBe('c2');

        // Every subscription has its own secret.
        await subscribe({ arguments: { severity: 'P2' } });
        expect(secretOf(subscribes()[2]!)).not.toBe(secretOf(first));
    });

    it('sends maxAgeMs until a refresh after the subscribe succeeds, though the cursor has not moved', async () => {
        const { subscribes, subscribe } = await webhookWith(granting({ cursor: 'c0' }, { cursor: 'c0' }, { cursor: 'c0' }));
        await subscribe({ cursor: 'c0', maxAgeMs: 300_000 });
        await vi.advanceTimersByTimeAsync(45_000);
        await vi.advanceTimersByTimeAsync(45_000);
        expect(subscribes().map(call => [call.params['cursor'], call.params['maxAgeMs']])).toEqual([
            ['c0', 300_000],
            ['c0', 300_000],
            ['c0', undefined]
        ]);
    });

    it('exposes deliveryStatus from the refresh', async () => {
        const failing = {
            active: false,
            lastDeliveryAt: '2026-11-18T00:00:00Z',
            lastError: 'http_4xx',
            failedSince: '2026-11-18T00:01:00Z'
        };
        const { subscribe } = await webhookWith(granting({}, { deliveryStatus: failing }, {}));
        const sub = await subscribe();
        expect(sub.deliveryStatus).toBeUndefined();

        await vi.advanceTimersByTimeAsync(45_000);
        expect(sub.deliveryStatus).toEqual(failing);
        // A refresh answered without it (another replica) leaves the last one reported.
        await vi.advanceTimersByTimeAsync(45_000);
        expect(sub.deliveryStatus).toEqual(failing);
    });

    it('unsubscribes on cancel()', async () => {
        const { post, subscribes, unsubscribes, subscribe } = await webhookWith(granting({}));
        const sub = await subscribe({ arguments: { severity: 'P1' } });
        const pending = sub[Symbol.asyncIterator]().next();

        await sub.cancel();
        expect(unsubscribes().map(call => call.params)).toEqual([
            { name: 'tick', arguments: { severity: 'P1' }, delivery: { url: WEBHOOK_URL }, _meta: expect.any(Object) }
        ]);
        expect(await pending).toEqual({ done: true, value: undefined });
        expect(await post(occurrence('e1'))).toBe(503);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(subscribes()).toHaveLength(1);
    });

    it('rejects a bad secretProvider value, and sends a good one as given', async () => {
        const bad = await webhookWith(granting({}), { secretProvider: () => 'nope' });
        await expect(bad.events.subscribe({ name: 'tick' })).rejects.toThrow(TypeError);
        expect(bad.subscribes()).toEqual([]);

        const secret = generateWebhookSecret();
        const good = await webhookWith(granting({}), { secretProvider: () => secret });
        await good.subscribe();
        expect(secretOf(good.subscribes()[0]!)).toBe(secret);
    });

    it('rejects a secretProvider value that another open subscription already uses', async () => {
        const secret = generateWebhookSecret();
        const { events, subscribes, subscribe } = await webhookWith(granting({}, { id: 'sub_2' }), { secretProvider: () => secret });
        const [first, second] = await Promise.allSettled([1, 2].map(a => events.subscribe({ name: 'tick', arguments: { a } })));
        expect(first?.status).toBe('fulfilled');
        expect(second).toMatchObject({ status: 'rejected', reason: expect.any(TypeError) });
        expect(subscribes()).toHaveLength(1);

        // Once that subscription has ended, its secret is free again.
        await (first as PromiseFulfilledResult<EventSubscription>).value.cancel();
        await subscribe({ arguments: { a: 2 } });
        expect(subscribes()).toHaveLength(2);
    });

    it('delivers events through the receiver once per eventId, persisting each watermark cursor', async () => {
        const { post, subscribe } = await webhookWith(granting({ cursor: 'c0' }));
        const sub = await subscribe();

        expect(await post({ ...occurrence('e1'), cursor: 'c1' })).toBe(200);
        // The same event under another webhook-id (as from another replica) is not delivered again.
        expect(await post({ ...occurrence('e1'), cursor: 'c1' })).toBe(200);
        expect(await post({ ...occurrence('e2'), cursor: 'c2' })).toBe(200);

        const iterator = sub[Symbol.asyncIterator]();
        expect(await nextEventId(iterator)).toBe('e1');
        expect(await nextEventId(iterator)).toBe('e2');
        expect(sub.cursor).toBe('c1');
        let settled = false;
        void iterator.next().then(() => (settled = true));
        await settle();
        expect(settled).toBe(false);
        expect(sub.cursor).toBe('c2');
    });

    it('answers the verification challenge sent during events/subscribe and routes deliveries that precede the response', async () => {
        const challenges: unknown[] = [];
        const early: number[] = [];
        const receiver: { handle?: (request: Request) => Promise<Response> } = {};
        const { handler, subscribe } = await webhookWith(async params => {
            const secret = (params['delivery'] as { secret: string }).secret;
            const answer = await receiver.handle!(await webhookPost({ type: 'verification', challenge: 'nonce-1' }, secret, 'sub_1'));
            challenges.push(await answer.json());
            const delivered = await receiver.handle!(await webhookPost({ ...occurrence('e1'), cursor: 'c1' }, secret, 'sub_1'));
            early.push(delivered.status);
            return grant({ cursor: 'c1' });
        });
        receiver.handle = handler;
        const sub = await subscribe();

        expect(challenges).toEqual([{ challenge: 'nonce-1' }]);
        expect(early).toEqual([200]);
        expect(await nextEventId(sub[Symbol.asyncIterator]())).toBe('e1');
    });

    it('reports truncated and gap bodies through onGap and persists their cursor', async () => {
        const onGap = vi.fn();
        const { post, subscribes, subscribe } = await webhookWith(granting({ cursor: 'c5', truncated: true }));
        const sub = await subscribe({ cursor: 'c0', onGap });

        expect(subscribes()[0]!.params['cursor']).toBe('c0');
        expect(onGap).toHaveBeenCalledExactlyOnceWith('c5');
        expect(sub.cursor).toBe('c5');

        expect(await post({ type: 'gap', cursor: 'c9' })).toBe(200);
        expect(onGap).toHaveBeenLastCalledWith('c9');
        expect(sub.cursor).toBe('c9');
    });

    it('fails the iterator on a terminated body with forbidden, and stops refreshing', async () => {
        const { post, subscribes, unsubscribes, subscribe } = await webhookWith(granting({}));
        const sub = await subscribe();
        await post({ ...occurrence('e1'), cursor: 'c1' });
        await post({ type: 'terminated', error: { code: -32_024, message: 'Forbidden', data: { reason: 'Access revoked' } } });
        await settle();

        const iterator = sub[Symbol.asyncIterator]();
        expect(await nextEventId(iterator)).toBe('e1');
        const error = await iterator.next().catch((error_: unknown) => error_);
        expect(error).toBeInstanceOf(EventsError);
        expect(error).toMatchObject({ kind: 'forbidden', data: { reason: 'Access revoked' } });
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(subscribes()).toHaveLength(1);
        expect(await post(occurrence('e2'))).toBe(503);

        // The server no longer holds the subscription, so there is nothing to unsubscribe.
        await sub.cancel();
        expect(unsubscribes()).toEqual([]);
    });

    it('resubscribes with the last cursor after a terminated notFound while the event is listed, and fails once it is not', async () => {
        const listed = [[tick], [tick], []];
        const { lists, post, subscribes, subscribe } = await webhookWith(granting({ cursor: 'c1' }, { cursor: 'c2' }), {
            list: () => ({ events: listed.shift() ?? [] })
        });
        const sub = await subscribe();
        const notFound = { code: -32_023, message: 'Not found', data: { kind: 'event' } };

        await post({ type: 'terminated', error: notFound });
        await settle();
        expect(lists()).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(500);
        expect(subscribes()).toHaveLength(2);
        expect(subscribes()[1]!.params['cursor']).toBe('c1');

        const pending = sub[Symbol.asyncIterator]()
            .next()
            .catch((error_: unknown) => error_);
        await post({ type: 'terminated', error: notFound });
        const error = await pending;
        expect(error).toBeInstanceOf(EventsError);
        expect(error).toMatchObject({ kind: 'notFound', data: { kind: 'event' } });
        expect(lists()).toHaveLength(3);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('starts again from now when the server keeps refusing the last cursor after a schema change', async () => {
        const onGap = vi.fn();
        const { lists, post, subscribes, subscribe } = await webhookWith(
            granting({ cursor: 'c1' }, new RpcError(-32_026, 'Unsupported', schemaChange), { cursor: 'v2:0' })
        );
        const sub = await subscribe({ onGap });

        await post({ type: 'terminated', error: { code: -32_026, message: 'Unsupported', data: schemaChange } });
        await vi.advanceTimersByTimeAsync(500);
        await vi.advanceTimersByTimeAsync(1000);

        expect(subscribes().map(call => call.params['cursor'])).toEqual([null, 'c1', null]);
        expect(lists()).toHaveLength(3);
        expect(onGap).toHaveBeenCalledExactlyOnceWith('v2:0');
        expect(sub.cursor).toBe('v2:0');
    });

    it('fails the iterator when a refresh is refused with an Events kind other than notFound or a schema change', async () => {
        for (const refusal of [
            new RpcError(-32_024, 'Forbidden'),
            new RpcError(-32_602, 'Invalid arguments'),
            new RpcError(-32_025, 'Too many subscriptions', { limit: 'subscriptions' }),
            new RpcError(-32_026, 'Unsupported', { feature: 'deliveryMode', value: 'webhook' }),
            new RpcError(-32_027, 'Callback endpoint error', { reason: 'challenge_failed' })
        ]) {
            const { lists, post, subscribes, unsubscribes, subscribe } = await webhookWith(granting({}, refusal));
            const sub = await subscribe();
            const pending = sub[Symbol.asyncIterator]()
                .next()
                .catch((error_: unknown) => error_);

            await vi.advanceTimersByTimeAsync(45_000);
            const error = await pending;
            expect(error).toBeInstanceOf(EventsError);
            expect(error).toMatchObject({ code: refusal.code });
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(120_000);
            expect(subscribes()).toHaveLength(2);
            expect(lists()).toHaveLength(1);
            expect(await post(occurrence('e1'))).toBe(503);
            // Left to lapse: the next identical subscription could already be on the same server subscription.
            await sub.cancel();
            expect(unsubscribes()).toEqual([]);
        }
    });

    it('fails the iterator on an auth failure of a refresh, without refreshing again', async () => {
        const { client, post, subscribes, subscribe } = await webhookWith(granting({}, {}));
        const sub = await subscribe();
        const refreshes = failSends(client, 'events/subscribe', authFailure);
        const pending = sub[Symbol.asyncIterator]()
            .next()
            .catch((error_: unknown) => error_);

        await vi.advanceTimersByTimeAsync(45_000);
        expect(await pending).toBeInstanceOf(UnauthorizedError);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(refreshes()).toBe(1);
        expect(subscribes()).toHaveLength(1);
        expect(await post(occurrence('e1'))).toBe(503);
    });

    it('retries a refresh that fails transiently after a jittered delay, with the last cursor', async () => {
        const internal = new RpcError(-32_603, 'Internal error');
        const { subscribes, subscribe } = await webhookWith(granting({ cursor: 'c1' }, internal, internal, { cursor: 'c2' }, internal, {}));
        const sub = await subscribe();
        await vi.advanceTimersByTimeAsync(45_000);
        expect(subscribes()).toHaveLength(2);

        // random() is 0.5: half of min(30 s, 1 s × 2^attempt).
        for (const delay of [500, 1000]) {
            const before = subscribes().length;
            await vi.advanceTimersByTimeAsync(delay - 1);
            expect(subscribes()).toHaveLength(before);
            await vi.advanceTimersByTimeAsync(1);
            expect(subscribes()).toHaveLength(before + 1);
        }
        expect(subscribes().map(call => call.params['cursor'])).toEqual([null, 'c1', 'c1', 'c1']);
        expect(sub.cursor).toBe('c2');

        // Back on the grant's schedule after the success, and the backoff starts over.
        await vi.advanceTimersByTimeAsync(44_999);
        expect(subscribes()).toHaveLength(4);
        await vi.advanceTimersByTimeAsync(1);
        expect(subscribes()).toHaveLength(5);
        await vi.advanceTimersByTimeAsync(500);
        expect(subscribes()).toHaveLength(6);
    });

    it('waits at most the longest timer before refreshing a far-off or null grant', async () => {
        const { subscribes, subscribe } = await webhookWith(
            granting({ refreshBefore: '2100-01-01T00:00:00Z' }, { refreshBefore: null }, {})
        );
        await subscribe();

        for (const count of [2, 3]) {
            await vi.advanceTimersByTimeAsync(2_147_483_646);
            expect(subscribes()).toHaveLength(count - 1);
            await vi.advanceTimersByTimeAsync(1);
            expect(subscribes()).toHaveLength(count);
        }
    });

    it('never refreshes sooner than pollIntervalFloorMs, even when refreshBefore has already passed', async () => {
        // A server clock behind the client's by more than the grant.
        const pastDue: Handler = () => grant({ refreshBefore: new Date(Date.now() - 10_000).toISOString() });
        const { subscribes, subscribe } = await webhookWith(pastDue);
        await subscribe();
        expect(subscribes()).toHaveLength(1);

        for (const count of [2, 3, 4]) {
            await vi.advanceTimersByTimeAsync(999);
            expect(subscribes()).toHaveLength(count - 1);
            await vi.advanceTimersByTimeAsync(1);
            expect(subscribes()).toHaveLength(count);
        }
    });

    it('keeps a refresh before refreshBefore when pollIntervalFloorMs would reach it', async () => {
        // A 60 s grant: a 50 s floor still fits before it, while a 60 s one would land on refreshBefore and falls back to ¾ of the grant.
        for (const [pollIntervalFloorMs, refreshAt] of [
            [50_000, 50_000],
            [60_000, 45_000]
        ] as const) {
            const { subscribes, subscribe } = await webhookWith(granting({}, {}), { pollIntervalFloorMs });
            await subscribe();
            await vi.advanceTimersByTimeAsync(refreshAt - 1);
            expect(subscribes()).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(subscribes()).toHaveLength(2);
        }
    });

    it('shares one server subscription among identical webhook subscriptions, each with its own iterator', async () => {
        const onGap = vi.fn();
        const firstGap = vi.fn();
        const { post, subscribes, subscribe } = await webhookWith(granting({ cursor: 'c1' }, { cursor: 'c4' }, {}));
        const first = await subscribe({ arguments: { severity: 'P1', region: 'eu' }, onGap: firstGap });
        // The same arguments in another key order are the same server subscription.
        const second = await subscribe({ arguments: { region: 'eu', severity: 'P1' }, cursor: 'old', onGap });

        expect(subscribes()).toHaveLength(1);
        // It joins where the shared subscription is; its own cursor was elsewhere, so events may have been skipped.
        expect(onGap).toHaveBeenCalledExactlyOnceWith('c1');
        expect(second.cursor).toBe('c1');

        expect(await post({ ...occurrence('e1'), cursor: 'c2' })).toBe(200);
        expect(await post({ ...occurrence('e1'), cursor: 'c2' })).toBe(200);
        expect(await post({ ...occurrence('e2'), cursor: 'c3' })).toBe(200);
        // A gap reaches every one of them.
        expect(await post({ type: 'gap', cursor: 'g1' })).toBe(200);
        expect(firstGap.mock.calls).toEqual([['g1']]);
        expect(onGap.mock.calls).toEqual([['c1'], ['g1']]);
        const iterators = [first, second].map(sub => sub[Symbol.asyncIterator]());
        for (const iterator of iterators) {
            expect([await nextEventId(iterator), await nextEventId(iterator)]).toEqual(['e1', 'e2']);
        }

        // One refresh for both; its watermark reaches each once its loop is past e2. Other arguments are another server subscription.
        await vi.advanceTimersByTimeAsync(45_000);
        expect(subscribes()).toHaveLength(2);
        for (const iterator of iterators) void iterator.next();
        expect([first.cursor, second.cursor]).toEqual(['c4', 'c4']);
        await subscribe({ arguments: { severity: 'P2' } });
        expect(subscribes()).toHaveLength(3);
    });

    it('cancelling one of two identical webhook subscriptions keeps the other receiving; cancelling the last unsubscribes', async () => {
        const { post, subscribes, unsubscribes, subscribe } = await webhookWith(granting({}, {}));
        const first = await subscribe();
        const second = await subscribe();

        await first.cancel();
        expect(unsubscribes()).toEqual([]);
        expect(await post({ ...occurrence('e1'), cursor: 'c1' })).toBe(200);
        expect(await nextEventId(second[Symbol.asyncIterator]())).toBe('e1');

        await second.cancel();
        expect(unsubscribes()).toHaveLength(1);
        expect(await post(occurrence('e2'))).toBe(503);
        expect(vi.getTimerCount()).toBe(0);

        // Subscribing again opens a new server subscription.
        await subscribe();
        expect(subscribes()).toHaveLength(2);
    });

    it('opens an identical subscription only once an un-awaited cancel() has unsubscribed, however that is answered', async () => {
        for (const answer of [{}, new RpcError(-32_023, 'Not found', { kind: 'subscription' })]) {
            const { calls, post, subscribe, unsubscribe } = await heldUnsubscribe();
            try {
                const old = await subscribe();
                const cancelling = old.cancel();
                const subscribing = subscribe();
                await settle();
                // Nothing goes out for the new one while the old events/unsubscribe is unanswered.
                expect(calls.map(call => call.method)).toEqual(['events/list', 'events/subscribe', 'events/unsubscribe']);

                unsubscribe.answer(answer);
                await cancelling;
                const fresh = await subscribing;
                expect(calls.map(call => call.method)).toEqual([
                    'events/list',
                    'events/subscribe',
                    'events/unsubscribe',
                    'events/subscribe'
                ]);
                // Bound after the old one released the id: delivered, not 503.
                expect(await post({ ...occurrence('e1'), cursor: 'c1' })).toBe(200);
                expect(await nextEventId(fresh[Symbol.asyncIterator]())).toBe('e1');
            } finally {
                unsubscribe.answerAll();
            }
        }
    });

    it('ends an identical subscription waiting on an un-awaited cancel() with ConnectionClosed when the client closes', async () => {
        const { calls, client, events, subscribe, unsubscribe } = await heldUnsubscribe();
        try {
            const old = await subscribe();
            const cancelling = old.cancel();
            const subscribing = events.subscribe({ name: 'tick' }).catch((error_: unknown) => error_);
            await settle();

            await client.close();
            await cancelling;
            const error = await subscribing;
            expect(error).toBeInstanceOf(SdkError);
            expect(error).toMatchObject({ code: SdkErrorCode.ConnectionClosed });
            expect(calls.map(call => call.method)).toEqual(['events/list', 'events/subscribe', 'events/unsubscribe']);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            unsubscribe.answerAll();
        }
    });

    it('ends every identical webhook subscription with the same error on a termination or a close', async () => {
        for (const end of ['terminated', 'close'] as const) {
            const { client, post, subscribes, subscribe } = await webhookWith(granting({}, {}));
            const subs = [await subscribe(), await subscribe()];
            const pending = subs.map(sub =>
                sub[Symbol.asyncIterator]()
                    .next()
                    .catch((error_: unknown) => error_)
            );

            await (end === 'terminated' ? post({ type: 'terminated', error: { code: -32_024, message: 'Forbidden' } }) : client.close());
            const [one, two] = await Promise.all(pending);
            expect(one).toBeInstanceOf(end === 'terminated' ? EventsError : SdkError);
            expect(two).toBe(one);
            expect(vi.getTimerCount()).toBe(0);
            // The next identical subscription opens a new server subscription rather than joining the ended one.
            if (end === 'terminated') {
                const again = await subscribe();
                expect(subscribes()).toHaveLength(2);
                await again.cancel();
            }
        }
    });

    it('settles a subscription that joins during the first exchange with that exchange', async () => {
        const gate: { refuse?: () => void } = {};
        const { events, subscribes } = await webhookWith(
            () => new Promise<never>((_resolve, reject) => (gate.refuse = () => reject(new RpcError(-32_024, 'Forbidden'))))
        );
        const one = events.subscribe({ name: 'tick' }).catch((error_: unknown) => error_);
        const two = events.subscribe({ name: 'tick' }).catch((error_: unknown) => error_);
        await settle();
        expect(subscribes()).toHaveLength(1);

        gate.refuse!();
        const [first, second] = await Promise.all([one, two]);
        expect(first).toBeInstanceOf(EventsError);
        expect(first).toMatchObject({ kind: 'forbidden' });
        expect(second).toBe(first);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('mirrors annotated arguments into Mcp-Param headers on subscribe, refresh and unsubscribe', async () => {
        const annotated = descriptor('tick', {
            delivery: ['webhook'],
            inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' } } }
        });
        const { subscribes, unsubscribes, subscribe } = await webhookWith(granting({}, {}), { list: listing(annotated) });
        const sub = await subscribe({ arguments: { region: 'us-west1' } });
        await vi.advanceTimersByTimeAsync(45_000);
        await sub.cancel();

        expect([...subscribes(), ...unsubscribes()].map(call => call.headers)).toEqual([
            { 'Mcp-Param-Region': 'us-west1' },
            { 'Mcp-Param-Region': 'us-west1' },
            { 'Mcp-Param-Region': 'us-west1' }
        ]);
    });

    it('rejects subscribe() when events/subscribe mismatches Mcp-Param headers again after a re-list', async () => {
        const mismatch = new RpcError(-32_020, 'Mcp-Param-Region header mismatch');
        const { events, lists, subscribes } = await webhookWith(granting(mismatch, mismatch));
        const error = await events.subscribe({ name: 'tick' }).catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(ProtocolError);
        expect(error).toMatchObject({ code: -32_020 });
        expect(subscribes()).toHaveLength(2);
        expect(lists()).toHaveLength(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('ends the loop on a refresh that mismatches Mcp-Param headers again after a re-list', async () => {
        const mismatch = new RpcError(-32_020, 'Mcp-Param-Region header mismatch');
        const { lists, subscribes, subscribe } = await webhookWith(granting({}, mismatch, mismatch));
        const sub = await subscribe();
        const pending = sub[Symbol.asyncIterator]()
            .next()
            .catch((error_: unknown) => error_);

        await vi.advanceTimersByTimeAsync(45_000);
        const error = await pending;
        expect(error).toBeInstanceOf(ProtocolError);
        expect(error).toMatchObject({ code: -32_020 });
        expect(subscribes()).toHaveLength(3);
        expect(lists()).toHaveLength(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects subscribe() when the first events/subscribe is refused, leaving nothing running', async () => {
        const refusals = [
            new RpcError(-32_023, 'Not found', { kind: 'event' }),
            new RpcError(-32_602, 'Invalid arguments'),
            new RpcError(-32_024, 'Forbidden'),
            new RpcError(-32_025, 'Too many subscriptions', { limit: 'subscriptions' }),
            new RpcError(-32_026, 'Unsupported', { feature: 'deliveryMode', value: 'webhook' }),
            new RpcError(-32_027, 'Callback endpoint error', { reason: 'challenge_failed' }),
            // Without a cursor there is no stale one to drop, so a schema change refuses too.
            new RpcError(-32_026, 'Unsupported', schemaChange)
        ];
        for (const refusal of refusals) {
            const { events, handler, lists, subscribes } = await webhookWith(granting(refusal));
            const error = await events.subscribe({ name: 'tick' }).catch((error_: unknown) => error_);
            expect(error).toBeInstanceOf(EventsError);
            expect(error).toMatchObject({ code: refusal.code });
            expect(vi.getTimerCount()).toBe(0);

            // The receiver no longer holds the secret.
            const challenge = await handler(
                await webhookPost({ type: 'verification', challenge: 'n' }, secretOf(subscribes()[0]!), 'sub_1')
            );
            expect(challenge.status).toBe(401);
            await vi.advanceTimersByTimeAsync(120_000);
            expect(subscribes()).toHaveLength(1);
            // A refused delivery mode lists the event types again, which still select it.
            expect(lists()).toHaveLength(refusal.data?.['feature'] === 'deliveryMode' ? 2 : 1);
        }
    });

    it('rejects subscribe() on a refreshBefore that is not a date', async () => {
        const { events, subscribes } = await webhookWith(granting({ refreshBefore: 'soon' }));
        const error = await events.subscribe({ name: 'tick' }).catch((error_: unknown) => error_);
        expect(error).toBeInstanceOf(SdkError);
        expect(error).toMatchObject({ code: SdkErrorCode.InvalidResult });
        expect(vi.getTimerCount()).toBe(0);
        expect(subscribes()).toHaveLength(1);
    });

    it('resolves subscribe() after a transient first failure and subscribes after a jittered delay', async () => {
        const { post, subscribes, subscribe } = await webhookWith(granting(new RpcError(-32_603, 'Internal error'), { cursor: 'c1' }));
        const sub = await subscribe({ cursor: 'c0' });
        expect(subscribes()).toHaveLength(1);
        expect(sub.cursor).toBe('c0');

        await vi.advanceTimersByTimeAsync(499);
        expect(subscribes()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(subscribes()).toHaveLength(2);
        expect(subscribes()[1]!.params['cursor']).toBe('c0');
        expect(sub.cursor).toBe('c1');
        expect(await post({ ...occurrence('e1'), cursor: 'c2' })).toBe(200);
        expect(await nextEventId(sub[Symbol.asyncIterator]())).toBe('e1');
    });

    it("retries the server's verification limit after data.retryAfterMs, first and once subscribed; a subscriptions limit still rejects", async () => {
        const limited = (retryAfterMs?: unknown) =>
            new RpcError(-32_025, 'Too many webhook endpoint verifications for this host', {
                limit: 'verification',
                ...(retryAfterMs !== undefined && { retryAfterMs })
            });
        const { subscribes, subscribe } = await webhookWith(granting(limited(7000), { cursor: 'c1' }, limited(12_000), limited(), {}));
        const sub = await subscribe({ cursor: 'c0' });
        expect(subscribes()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(6999);
        expect(subscribes()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(subscribes()).toHaveLength(2);
        expect(sub.cursor).toBe('c1');

        // The refresh at ¾ of the grant is limited too: it waits retryAfterMs, then the backoff when the hint is missing.
        await vi.advanceTimersByTimeAsync(45_000);
        expect(subscribes()).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(12_000);
        expect(subscribes()).toHaveLength(4);
        await vi.advanceTimersByTimeAsync(500);
        expect(subscribes()).toHaveLength(5);
        expect(subscribes().map(call => call.params['cursor'])).toEqual(['c0', 'c0', 'c1', 'c1', 'c1']);

        const refused = await webhookWith(granting(new RpcError(-32_025, 'Too many subscriptions', { limit: 'subscriptions' })));
        const error = await refused.events.subscribe({ name: 'tick' }).catch((error_: unknown) => error_);
        expect(error).toBeInstanceOf(EventsError);
        expect(error).toMatchObject({ kind: 'resourceExhausted', data: { limit: 'subscriptions' } });
    });

    it('drops a stale cursor that the first events/subscribe refuses for a schema change, and starts from now', async () => {
        const onGap = vi.fn();
        const { events, lists, subscribes } = await webhookWith(
            granting(new RpcError(-32_026, 'Unsupported', { feature: 'inputSchema', reason: 'schema_changed' }), { cursor: 'v2:0' })
        );
        const subscribing = events.subscribe({ name: 'tick', cursor: 'stale', onGap });
        await settle();
        await vi.advanceTimersByTimeAsync(500);
        const sub = await subscribing;
        subscriptions.push(sub);

        expect(subscribes().map(call => call.params['cursor'])).toEqual(['stale', null]);
        expect(lists()).toHaveLength(2);
        expect(onGap).toHaveBeenCalledExactlyOnceWith('v2:0');
        expect(sub.cursor).toBe('v2:0');
    });

    it('rejects subscribe() after a schema change refuses its cursor when the type no longer offers webhook', async () => {
        const listed = [[tick], [descriptor('tick', { delivery: ['poll'] })]];
        const { events, subscribes } = await webhookWith(granting(new RpcError(-32_026, 'Unsupported', schemaChange)), {
            list: () => ({ events: listed.shift() ?? [] })
        });
        const error = await events.subscribe({ name: 'tick', cursor: 'stale' }).catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(NoCompatibleDeliveryModeError);
        expect(error).toMatchObject({ eventName: 'tick', offered: ['poll'], usable: ['webhook'] });
        expect(subscribes()).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects subscribe() with ConnectionClosed when the client closes before events/subscribe answers', async () => {
        const { client, events, subscribes } = await webhookWith(granting());
        const subscribing = events.subscribe({ name: 'tick' }).catch((error_: unknown) => error_);
        await settle();
        expect(subscribes()).toHaveLength(1);

        await client.close();
        const error = await subscribing;
        expect(error).toBeInstanceOf(SdkError);
        expect(error).toMatchObject({ code: SdkErrorCode.ConnectionClosed });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('ends the loop with ConnectionClosed when the client closes, releasing the receiver and stopping refreshes', async () => {
        const { client, post, subscribes, unsubscribes, subscribe } = await webhookWith(granting({}));
        const sub = await subscribe();
        const pending = sub[Symbol.asyncIterator]()
            .next()
            .catch((error_: unknown) => error_);

        await client.close();
        const error = await pending;
        expect(error).toBeInstanceOf(SdkError);
        expect(error).toMatchObject({ code: SdkErrorCode.ConnectionClosed });
        expect(vi.getTimerCount()).toBe(0);
        expect(await post(occurrence('e1'))).toBe(503);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(subscribes()).toHaveLength(1);
        await sub.cancel();
        expect(unsubscribes()).toEqual([]);
    });

    it('ends the loop with ConnectionClosed when the client reconnects without closing', async () => {
        const { post, reconnect, subscribes, unsubscribes, subscribe } = await webhookWith(granting({}));
        const sub = await subscribe();
        const pending = sub[Symbol.asyncIterator]()
            .next()
            .catch((error_: unknown) => error_);

        await reconnect();
        const error = await pending;
        expect(error).toBeInstanceOf(SdkError);
        expect(error).toMatchObject({ code: SdkErrorCode.ConnectionClosed });
        expect(vi.getTimerCount()).toBe(0);
        expect(await post(occurrence('e1'))).toBe(503);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(subscribes()).toHaveLength(1);
        // Subscribing again on the new connection would reach the same server subscription; cancel() leaves it alone.
        await sub.cancel();
        expect(unsubscribes()).toEqual([]);
    });
});
