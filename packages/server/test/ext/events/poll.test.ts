import { PollEventsResultSchema } from '@modelcontextprotocol/core/ext/events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

import type { EmitFanOut } from '../../../src/ext/events/extension';
import type { CheckContext, EventContext, EventsOptions, PollEventsResult } from '../../../src/ext/events/index';
import { EventsError, EventsExtension } from '../../../src/ext/events/index';
import { leaseKey } from '../../../src/ext/events/leases';
import type { EventsTestHook } from '../../../src/ext/events/testHook';
import { errorOf, resultOf, serve } from './harness';

const P = z.object({ n: z.number() });
const tick = () => ({ events: [], cursor: 'h0' });

function testHook(events: EventsExtension): EventsTestHook {
    return (events as unknown as Record<symbol, EventsTestHook>)[Symbol.for('mcp.events.testHook')]!;
}

// A result without the `_meta` the server adds to every result.
function bodyOf(reply: Parameters<typeof resultOf>[0]): Record<string, unknown> {
    const { _meta, ...body } = resultOf(reply);
    return body;
}

function poller(events: EventsExtension, options?: Parameters<typeof serve>[1]) {
    const { rpc } = serve(events, options);
    return {
        poll: async (params: Record<string, unknown>) => resultOf(await rpc('events/poll', params)) as PollEventsResult,
        fail: async (params: Record<string, unknown>) => errorOf(await rpc('events/poll', params)),
        rpc
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('events/poll for a check type', () => {
    it('bootstraps a check type with cursor null', async () => {
        const events = new EventsExtension();
        const check = vi.fn(() => ({ events: [{ eventId: 'e1', data: { n: 1 } }], cursor: 'h1' }));
        events.registerEvent('t', { payloadSchema: P, check });
        const { rpc } = poller(events);
        expect(bodyOf(await rpc('events/poll', { name: 't', cursor: null }))).toEqual({
            resultType: 'complete',
            events: [],
            cursor: 'h1',
            truncated: false,
            hasMore: false,
            nextPollMs: 30_000
        });
        expect(check).toHaveBeenCalledOnce();
        expect(check.mock.calls[0]).toEqual([expect.objectContaining({ name: 't', mode: 'poll' }), {}, null]);
    });

    it('treats an absent cursor as null', async () => {
        const events = new EventsExtension();
        const check = vi.fn((_ctx: CheckContext, _args: unknown, _cursor: string | null) => ({ events: [], cursor: 'h1' }));
        events.registerEvent('t', { payloadSchema: P, check });
        expect(await poller(events).poll({ name: 't' })).toMatchObject({ events: [], cursor: 'h1' });
        expect(check.mock.calls[0]![2]).toBeNull();
    });

    it('fills name and timestamp on check events', async () => {
        const events = new EventsExtension({ defaultNextPollMs: 1000 });
        events.registerEvent('t', {
            payloadSchema: P,
            check: () => ({
                events: [
                    { eventId: 'upstream-1', data: { n: 1 } },
                    { eventId: 'upstream-2', timestamp: '2026-01-01T00:00:00.000Z', data: { n: 2 }, _meta: { k: 1 } }
                ],
                cursor: 'h2',
                nextPollMs: 5000
            })
        });
        const result = await poller(events).poll({ name: 't', cursor: 'h1' });
        const [first, second] = result.events;
        expect(first).toMatchObject({ eventId: 'upstream-1', name: 't', data: { n: 1 } });
        expect(new Date(first!.timestamp).toISOString()).toBe(first!.timestamp);
        expect(first).not.toHaveProperty('cursor');
        expect(second).toEqual({
            eventId: 'upstream-2',
            name: 't',
            timestamp: '2026-01-01T00:00:00.000Z',
            data: { n: 2 },
            _meta: { k: 1 }
        });
        expect(result).toMatchObject({ cursor: 'h2', truncated: false, hasMore: false, nextPollMs: 5000 });
    });

    it.each([
        [5062.5, 5063],
        [-1, 0],
        [Number.NaN, 1000],
        [Number.POSITIVE_INFINITY, 1000]
    ])('sends a nextPollMs of %s from check as %i, which the wire schema accepts', async (given, sent) => {
        const events = new EventsExtension({ defaultNextPollMs: 1000 });
        events.registerEvent('t', { payloadSchema: P, check: () => ({ events: [], cursor: 'h1', nextPollMs: given }) });
        const result = await poller(events).poll({ name: 't', cursor: 'h0' });
        expect(result.nextPollMs).toBe(sent);
        expect(PollEventsResultSchema.safeParse(result).success).toBe(true);
    });

    it('caps nextPollMs at half of pollSubscriptionTtlMs, so a client that follows it keeps its lease', async () => {
        // The default nextPollMs (30 s) is over half of this TTL, so it is capped too.
        const events = new EventsExtension({ pollSubscriptionTtlMs: 50_001 });
        let nextPollMs: number | undefined = 600_000;
        events.registerEvent('t', { payloadSchema: P, check: () => ({ events: [], cursor: 'h1', nextPollMs }) });
        events.registerEvent('i', { emitOnly: true, payloadSchema: P });
        const { poll } = poller(events);
        expect((await poll({ name: 't', cursor: 'h0' })).nextPollMs).toBe(25_000);
        nextPollMs = undefined;
        expect((await poll({ name: 't', cursor: 'h0' })).nextPollMs).toBe(25_000);
        expect((await poll({ name: 'i', cursor: null })).nextPollMs).toBe(25_000);
    });

    it('passes hasMore and truncated through from check', async () => {
        const events = new EventsExtension();
        events.registerEvent('t', { payloadSchema: P, check: () => ({ events: [], cursor: 'h2', hasMore: true, truncated: true }) });
        expect(await poller(events).poll({ name: 't', cursor: 'h1' })).toMatchObject({ truncated: true, hasMore: true });
    });

    it('answers truncated: false for a result with cursor: null (SEP-3415 §Cursor Lifecycle)', async () => {
        const events = new EventsExtension();
        events.registerEvent('t', { payloadSchema: P, check: () => ({ events: [], cursor: null, truncated: true }) });
        expect(await poller(events).poll({ name: 't', cursor: 'h1' })).toMatchObject({ events: [], cursor: null, truncated: false });
    });

    it('delivers what check(null) returns from the second poll of a lease on, for a type without replay', async () => {
        vi.useFakeTimers();
        const onUnsubscribe = vi.fn();
        const events = new EventsExtension({ pollSubscriptionTtlMs: 300_000 });
        let beat = 0;
        const check = vi.fn((_ctx: CheckContext, _args: unknown, _cursor: string | null) => {
            beat += 1;
            return { events: [{ eventId: `b${beat}`, data: { n: beat } }], cursor: null, hasMore: true };
        });
        events.registerEvent('pulse', { payloadSchema: P, check, onUnsubscribe });
        const { poll } = poller(events);

        expect(await poll({ name: 'pulse', cursor: null })).toMatchObject({ events: [], cursor: null, truncated: false, hasMore: false });
        const second = await poll({ name: 'pulse', cursor: null });
        expect(second.events.map(event => event.eventId)).toEqual(['b2']);
        expect(second).toMatchObject({ cursor: null, truncated: false, hasMore: true });
        expect((await poll({ name: 'pulse' })).events.map(event => event.eventId)).toEqual(['b3']);
        expect(check.mock.calls.map(([, , cursor]) => cursor)).toEqual([null, null, null]);
        const [subscriptionId, ...others] = new Set(check.mock.calls.map(([ctx]) => ctx.subscriptionId));
        expect(others).toEqual([]);

        await vi.advanceTimersByTimeAsync(300_001);
        expect(onUnsubscribe).toHaveBeenCalledOnce();
        expect((onUnsubscribe.mock.calls[0]![0] as EventContext).subscriptionId).toBe(subscriptionId);
        // The next poll starts a new lease, which bootstraps again.
        expect(await poll({ name: 'pulse', cursor: null })).toMatchObject({ events: [], cursor: null });
        expect(check.mock.calls[3]![0].subscriptionId).not.toBe(subscriptionId);
    });

    it('starts a type with replay from now on every cursor: null poll', async () => {
        const events = new EventsExtension();
        events.registerEvent('t', { payloadSchema: P, check: () => ({ events: [{ eventId: 'e1', data: { n: 1 } }], cursor: 'h1' }) });
        const { poll } = poller(events);
        expect(await poll({ name: 't', cursor: null })).toMatchObject({ events: [], cursor: 'h1' });
        expect(await poll({ name: 't', cursor: null })).toMatchObject({ events: [], cursor: 'h1' });
    });

    it('ignores maxAgeMs for a result with cursor: null', async () => {
        const events = new EventsExtension();
        const old = new Date(Date.now() - 600_000).toISOString();
        events.registerEvent('t', {
            payloadSchema: P,
            check: () => ({ events: [{ eventId: 'old', timestamp: old, data: { n: 1 } }], cursor: null })
        });
        const result = await poller(events).poll({ name: 't', cursor: 'h1', maxAgeMs: 300_000 });
        expect(result.events.map(event => event.eventId)).toEqual(['old']);
        expect(result.truncated).toBe(false);
    });

    it('applies the maxAgeMs floor and flags truncated', async () => {
        const events = new EventsExtension();
        const old = new Date(Date.now() - 600_000).toISOString();
        events.registerEvent('t', {
            payloadSchema: P,
            check: () => ({
                events: [
                    { eventId: 'old', timestamp: old, data: { n: 1 } },
                    { eventId: 'new', data: { n: 2 } }
                ],
                cursor: 'h2'
            })
        });
        const { poll } = poller(events);
        const bounded = await poll({ name: 't', cursor: 'h1', maxAgeMs: 300_000 });
        expect(bounded.events.map(event => event.eventId)).toEqual(['new']);
        expect(bounded.truncated).toBe(true);
        const unbounded = await poll({ name: 't', cursor: 'h1' });
        expect(unbounded.events.map(event => event.eventId)).toEqual(['old', 'new']);
        expect(unbounded.truncated).toBe(false);
    });

    it('delivers check events without a timestamp under a maxAgeMs floor, and reports them at once, then at most once a minute', async () => {
        vi.useFakeTimers();
        const onerror = vi.fn();
        const events = new EventsExtension({ onerror });
        const old = new Date(Date.now() - 600_000).toISOString();
        events.registerEvent('t', {
            payloadSchema: P,
            check: () => ({
                events: [
                    { eventId: 'untimed-1', data: { n: 1 } },
                    { eventId: 'old', timestamp: old, data: { n: 2 } },
                    { eventId: 'untimed-2', data: { n: 3 } }
                ],
                cursor: 'h2'
            })
        });
        const { poll } = poller(events);
        const reported = "event 't': check returned an event without a timestamp, so maxAgeMs cannot skip it; it is delivered";

        const bounded = await poll({ name: 't', cursor: 'h1', maxAgeMs: 300_000 });
        expect(bounded.events.map(event => event.eventId)).toEqual(['untimed-1', 'untimed-2']);
        expect(bounded.truncated).toBe(true);
        expect(onerror.mock.calls.map(([error]) => (error as Error).message)).toEqual([reported]);

        await vi.advanceTimersByTimeAsync(59_000);
        await poll({ name: 't', cursor: 'h1', maxAgeMs: 300_000 });
        expect(onerror).toHaveBeenCalledOnce();
        // Without a floor nothing is reported.
        await vi.advanceTimersByTimeAsync(1000);
        await poll({ name: 't', cursor: 'h1' });
        expect(onerror).toHaveBeenCalledOnce();
        await poll({ name: 't', cursor: 'h1', maxAgeMs: 300_000 });
        expect(onerror).toHaveBeenCalledTimes(2);
    });

    it('drops a check event without an eventId and reports it', async () => {
        const onerror = vi.fn();
        const events = new EventsExtension({ onerror });
        // As plain JavaScript returns them, past the type that requires eventId.
        const unidentified = [{ data: { n: 1 } }, { eventId: '', data: { n: 2 } }] as Array<{ eventId: string; data: { n: number } }>;
        events.registerEvent('t', {
            payloadSchema: P,
            check: () => ({ events: [...unidentified, { eventId: 'kept', data: { n: 3 } }], cursor: 'h2' })
        });
        const result = await poller(events).poll({ name: 't', cursor: 'h1' });
        expect(result.events.map(event => event.eventId)).toEqual(['kept']);
        expect(onerror).toHaveBeenCalledTimes(2);
        for (const [error] of onerror.mock.calls) {
            expect((error as Error).message).toBe("event 't': dropped an event from check without an eventId");
        }
    });

    it('drops an off-schema check payload and reports it', async () => {
        const onerror = vi.fn();
        const events = new EventsExtension({ onerror });
        events.registerEvent('t', {
            payloadSchema: P,
            check: () => ({
                events: [
                    { eventId: 'bad', data: { n: 'x' } as unknown as { n: number } },
                    { eventId: 'good', data: { n: 2 } }
                ],
                cursor: 'h2'
            })
        });
        const result = await poller(events).poll({ name: 't', cursor: 'h1' });
        expect(result.events.map(event => event.eventId)).toEqual(['good']);
        expect(onerror).toHaveBeenCalledOnce();
        expect(onerror.mock.calls[0]![0]).toBeInstanceOf(Error);
        expect(onerror.mock.calls[0]![0].message).toMatch(/^event 't': dropped an event whose data does not match payloadSchema: /);
    });

    it('passes principal and maxEvents in the context', async () => {
        const getPrincipal: EventsOptions['getPrincipal'] = ctx => (ctx.http?.authInfo?.extra?.sub as string | undefined) ?? null;
        const events = new EventsExtension({ getPrincipal });
        const check = vi.fn<(ctx: CheckContext) => { events: never[]; cursor: string }>(() => ({ events: [], cursor: 'h1' }));
        events.registerEvent('t', { payloadSchema: P, check });
        const authInfo = { token: 'tok', clientId: 'client', scopes: [], extra: { sub: 'u1' } };
        const { poll } = poller(events, { authInfo });
        await poll({ name: 't', cursor: 'h0', maxEvents: 25, maxAgeMs: 1000 });
        const ctx = check.mock.calls[0]![0];
        expect(ctx).toMatchObject({ name: 't', principal: 'u1', mode: 'poll', maxEvents: 25, maxAgeMs: 1000 });
        expect(ctx.subscriptionId).toEqual(expect.any(String));
        expect(Object.isFrozen(ctx)).toBe(true);
        await poll({ name: 't', cursor: 'h0' });
        expect(check.mock.calls[1]![0]).toMatchObject({ maxEvents: 100 });
        expect(check.mock.calls[1]![0]).not.toHaveProperty('maxAgeMs');
        expect(check.mock.calls[1]![0].subscriptionId).toBe(ctx.subscriptionId);

        const anonymous = new EventsExtension();
        const anonymousCheck = vi.fn<(ctx: CheckContext) => { events: never[]; cursor: string }>(() => ({ events: [], cursor: 'h1' }));
        anonymous.registerEvent('t', { payloadSchema: P, check: anonymousCheck });
        await poller(anonymous, { authInfo }).poll({ name: 't', cursor: null });
        expect(anonymousCheck.mock.calls[0]![0].principal).toBeNull();
    });

    it('caps ctx.maxEvents at 1 000 whatever maxEvents the poll asks for', async () => {
        const events = new EventsExtension();
        const check = vi.fn<(ctx: CheckContext) => { events: never[]; cursor: string }>(() => ({ events: [], cursor: 'h1' }));
        events.registerEvent('t', { payloadSchema: P, check });
        const { poll } = poller(events);
        await poll({ name: 't', cursor: 'h0', maxEvents: Number.MAX_SAFE_INTEGER });
        await poll({ name: 't', cursor: 'h0', maxEvents: 1000 });
        await poll({ name: 't', cursor: 'h0', maxEvents: 999 });
        expect(check.mock.calls.map(([ctx]) => ctx.maxEvents)).toEqual([1000, 1000, 999]);
    });
});

describe('events/poll for an emit-only type', () => {
    const Incident = z.object({ severity: z.string(), reporter: z.string().nullable() });

    it('serves an emit-only type from the buffer with match and transform', async () => {
        const events = new EventsExtension();
        const seen: EventContext[] = [];
        const handle = events.registerEvent('incident', {
            emitOnly: true,
            inputSchema: z.object({ severity: z.string().optional(), redact: z.boolean().optional() }),
            payloadSchema: Incident,
            match: (ctx, event, args) => {
                seen.push(ctx);
                return args.severity === undefined || event.data.severity === args.severity;
            },
            transform: (_ctx, event, args) => (args.redact ? { ...event, data: { ...event.data, reporter: null } } : event)
        });
        const { poll } = poller(events);
        const args = { severity: 'P1', redact: true };
        const { cursor } = await poll({ name: 'incident', arguments: args, cursor: null });
        await handle.emit({ eventId: 'inc-1', data: { severity: 'P1', reporter: 'ann' } });
        await handle.emit({ eventId: 'inc-3', data: { severity: 'P3', reporter: 'bob' } });
        const result = await poll({ name: 'incident', arguments: args, cursor });
        expect(result.events).toEqual([
            { eventId: 'inc-1', name: 'incident', timestamp: expect.any(String), data: { severity: 'P1', reporter: null } }
        ]);
        expect(result).toMatchObject({ truncated: false, hasMore: false, nextPollMs: 30_000 });
        expect(seen[0]).toMatchObject({ name: 'incident', mode: 'poll', principal: null });

        const all = await poll({ name: 'incident', cursor });
        expect(all.events.map(event => [event.eventId, event.data.reporter])).toEqual([
            ['inc-1', 'ann'],
            ['inc-3', 'bob']
        ]);
    });

    it('resolves emit() with no subscribers and serves it later (Review Focus 2)', async () => {
        const events = new EventsExtension();
        const h = events.registerEvent('i', { emitOnly: true, payloadSchema: P });
        await expect(h.emit({ data: { n: 1 } })).resolves.toBeUndefined();
        const { poll } = poller(events);
        const { cursor: c0 } = await poll({ name: 'i', cursor: null });
        await expect(h.emit({ data: { n: 2 } })).resolves.toBeUndefined();
        const result = await poll({ name: 'i', cursor: c0 });
        expect(result.events).toHaveLength(1);
        expect(result.events[0]).toMatchObject({ name: 'i', data: { n: 2 } });
        expect(result.events[0]!.eventId).toEqual(expect.any(String));
    });

    it('gives an emit without an eventId a generated one, the same on every read', async () => {
        const events = new EventsExtension();
        const h = events.registerEvent('i', { emitOnly: true, payloadSchema: P });
        const { poll } = poller(events);
        const { cursor } = await poll({ name: 'i', cursor: null });
        await h.emit({ data: { n: 1 } });
        const [first] = (await poll({ name: 'i', cursor })).events;
        const [again] = (await poll({ name: 'i', cursor })).events;
        expect(first!.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(again!.eventId).toBe(first!.eventId);
    });

    it('reports a gap for a cursor from before a restart (Review Focus 5)', async () => {
        const events = new EventsExtension();
        const h = events.registerEvent('i', { emitOnly: true, payloadSchema: P });
        const { poll, rpc } = poller(events);
        const { cursor: c0 } = await poll({ name: 'i', cursor: null });
        await h.emit({ data: { n: 1 } });
        await h.emit({ data: { n: 2 } });
        const reply = await rpc('events/poll', { name: 'i', cursor: 'e00000000.5' });
        expect(bodyOf(reply)).toEqual({
            resultType: 'complete',
            events: [],
            cursor: c0,
            truncated: true,
            hasMore: true,
            nextPollMs: 30_000
        });
        expect((await poll({ name: 'i', cursor: c0 })).events.map(event => event.data)).toEqual([{ n: 1 }, { n: 2 }]);
        expect(await poll({ name: 'i', cursor: 'garbage' })).toMatchObject({ events: [], cursor: c0, truncated: true });
    });

    it('serves a cursor the buffer evicted from the oldest event it holds, in one poll, while emits keep evicting', async () => {
        const events = new EventsExtension({ emitBuffer: { maxEvents: 5 } });
        const h = events.registerEvent('i', { emitOnly: true, payloadSchema: P });
        const { poll } = poller(events);
        let { cursor } = await poll({ name: 'i', cursor: null });
        const received: unknown[] = [];
        let n = 0;
        for (let round = 0; round < 3; round++) {
            // Ten emits between polls evict everything the last poll reached.
            for (let emitted = 0; emitted < 10; emitted++) await h.emit({ data: { n: ++n } });
            const result = await poll({ name: 'i', cursor, maxEvents: 3 });
            expect(result).toMatchObject({ truncated: true, hasMore: true });
            received.push(...result.events.map(event => event.data.n));
            cursor = result.cursor;
        }
        expect(received).toEqual([6, 7, 8, 16, 17, 18, 26, 27, 28]);
        // A cursor of another epoch (another replica, or one from before a restart) still reads as a gap without events.
        expect(await poll({ name: 'i', cursor: 'e00000000.5' })).toMatchObject({ events: [], truncated: true, hasMore: true });
    });

    it('drains with maxEvents and hasMore', async () => {
        const events = new EventsExtension();
        const h = events.registerEvent('i', { emitOnly: true, payloadSchema: P });
        const { poll } = poller(events);
        const { cursor } = await poll({ name: 'i', cursor: null });
        for (let n = 1; n <= 3; n++) await h.emit({ data: { n } });
        const first = await poll({ name: 'i', cursor, maxEvents: 2 });
        expect(first.events.map(event => event.data)).toEqual([{ n: 1 }, { n: 2 }]);
        expect(first.hasMore).toBe(true);
        const second = await poll({ name: 'i', cursor: first.cursor, maxEvents: 2 });
        expect(second.events.map(event => event.data)).toEqual([{ n: 3 }]);
        expect(second.hasMore).toBe(false);
    });

    it('caps a poll at 1 000 events whatever maxEvents asks for, and reports the rest through hasMore', async () => {
        const events = new EventsExtension();
        const h = events.registerEvent('i', { emitOnly: true, payloadSchema: P });
        const { poll } = poller(events);
        const { cursor } = await poll({ name: 'i', cursor: null });
        for (let n = 1; n <= 1001; n++) await h.emit({ data: { n } });
        const first = await poll({ name: 'i', cursor, maxEvents: Number.MAX_SAFE_INTEGER });
        expect(first.events).toHaveLength(1000);
        expect(first.events.at(-1)!.data).toEqual({ n: 1000 });
        expect(first.hasMore).toBe(true);
        const second = await poll({ name: 'i', cursor: first.cursor, maxEvents: Number.MAX_SAFE_INTEGER });
        expect(second.events.map(event => event.data)).toEqual([{ n: 1001 }]);
        expect(second.hasMore).toBe(false);
    });

    it('delivers an emit to every subscription match accepts', async () => {
        const events = new EventsExtension();
        const h = events.registerEvent('i', {
            emitOnly: true,
            inputSchema: z.object({ min: z.number() }),
            payloadSchema: P,
            match: (_ctx, event, args) => event.data.n >= args.min
        });
        const { poll } = poller(events);
        const low = await poll({ name: 'i', arguments: { min: 1 }, cursor: null });
        const high = await poll({ name: 'i', arguments: { min: 2 }, cursor: null });
        await h.emit({ data: { n: 1 } });
        await h.emit({ data: { n: 2 } });
        expect((await poll({ name: 'i', arguments: { min: 1 }, cursor: low.cursor })).events.map(event => event.data)).toEqual([
            { n: 1 },
            { n: 2 }
        ]);
        expect((await poll({ name: 'i', arguments: { min: 2 }, cursor: high.cursor })).events.map(event => event.data)).toEqual([{ n: 2 }]);
    });

    it('drops an off-schema emit and reports it', async () => {
        const onerror = vi.fn();
        const events = new EventsExtension({ onerror });
        const h = events.registerEvent('i', { emitOnly: true, payloadSchema: P });
        const { poll } = poller(events);
        const { cursor } = await poll({ name: 'i', cursor: null });
        await expect(h.emit({ data: { n: 'x' } as unknown as { n: number } })).resolves.toBeUndefined();
        expect(onerror).toHaveBeenCalledOnce();
        expect(onerror.mock.calls[0]![0].message).toMatch(/^event 'i': dropped an event whose data does not match payloadSchema: /);
        expect(await poll({ name: 'i', cursor })).toMatchObject({ events: [], cursor });
    });

    it('drops a transform output that fails payloadSchema and reports it', async () => {
        const onerror = vi.fn();
        const events = new EventsExtension({ onerror });
        const h = events.registerEvent('i', {
            emitOnly: true,
            payloadSchema: P,
            transform: (_ctx, event) => ({
                ...event,
                data: event.data.n === 1 ? ({ n: 'one' } as unknown as { n: number }) : { n: event.data.n * 10 }
            })
        });
        const { poll } = poller(events);
        const { cursor } = await poll({ name: 'i', cursor: null });
        await h.emit({ data: { n: 1 } });
        await h.emit({ data: { n: 2 } });
        const result = await poll({ name: 'i', cursor });
        expect(result.events.map(event => event.data)).toEqual([{ n: 20 }]);
        expect(await poll({ name: 'i', cursor: result.cursor })).toMatchObject({ events: [] });
        expect(onerror).toHaveBeenCalledOnce();
        expect(onerror.mock.calls[0]![0].message).toMatch(
            /^event 'i': dropped an event whose transform output does not match payloadSchema: /
        );
    });

    it('drops and reports an event JSON cannot carry, emitted, transformed or from check, and the poll succeeds', async () => {
        const onerror = vi.fn();
        const events = new EventsExtension({ onerror });
        const Loose = z.object({ n: z.number(), id: z.unknown().optional() });
        const h = events.registerEvent('i', {
            emitOnly: true,
            payloadSchema: Loose,
            transform: (_ctx, event) => (event.data.n === 3 ? { ...event, _meta: { big: 3n } } : event)
        });
        events.registerEvent('t', {
            payloadSchema: Loose,
            check: () => ({
                events: [
                    { eventId: 'big', data: { n: 1, id: 1n } },
                    { eventId: 'fine', data: { n: 2 } }
                ],
                cursor: 'h2'
            })
        });
        const { poll } = poller(events);
        const { cursor } = await poll({ name: 'i', cursor: null });
        await h.emit({ eventId: 'meta', data: { n: 1 }, _meta: { big: 1n } });
        await h.emit({ eventId: 'data', data: { n: 2, id: 2n } });
        await h.emit({ eventId: 'shaped', data: { n: 3 } });
        await h.emit({ eventId: 'fine', data: { n: 4 } });
        expect((await poll({ name: 'i', cursor })).events.map(event => event.eventId)).toEqual(['fine']);
        expect((await poll({ name: 't', cursor: 'h1' })).events.map(event => event.eventId)).toEqual(['fine']);
        const messages = onerror.mock.calls.map(([error]) => (error as Error).message);
        expect(messages).toHaveLength(4);
        for (const message of messages) expect(message).toMatch(/^event '[it]': dropped an event that cannot be serialised to JSON: /);
    });

    it('skips an event whose match throws and reports it', async () => {
        const onerror = vi.fn();
        const events = new EventsExtension({ onerror });
        const h = events.registerEvent('i', {
            emitOnly: true,
            payloadSchema: P,
            match: (_ctx, event) => {
                if (event.data.n === 1) throw new Error('match failed');
                return true;
            }
        });
        const { poll } = poller(events);
        const { cursor } = await poll({ name: 'i', cursor: null });
        await h.emit({ data: { n: 1 } });
        await h.emit({ data: { n: 2 } });
        expect((await poll({ name: 'i', cursor })).events.map(event => event.data)).toEqual([{ n: 2 }]);
        expect(onerror).toHaveBeenCalledWith(expect.objectContaining({ message: 'match failed' }));
    });

    it('hands each emit to the fan-out with its positions and reports a failing one', async () => {
        const onerror = vi.fn();
        const events = new EventsExtension({ onerror });
        const fanOut = vi.fn<EmitFanOut>(async () => {});
        testHook(events).addFanOut(fanOut);
        testHook(events).addFanOut(async () => {
            throw new Error('push failed');
        });
        const h = events.registerEvent('i', { emitOnly: true, payloadSchema: P });
        const { cursor: c0 } = await poller(events).poll({ name: 'i', cursor: null });
        await expect(h.emit({ eventId: 'x', data: { n: 1 } })).resolves.toBeUndefined();
        expect(fanOut).toHaveBeenCalledOnce();
        const [name, buffered, positions] = fanOut.mock.calls[0]!;
        expect(name).toBe('i');
        expect(buffered).toEqual({ occurrence: expect.objectContaining({ eventId: 'x', name: 'i', data: { n: 1 } }) });
        expect(positions.previous).toBe(c0);
        expect(positions.cursor).not.toBe(c0);
        expect(onerror).toHaveBeenCalledWith(expect.objectContaining({ message: 'push failed' }));
    });

    it('drops buffered events on remove() and on a schema change, so earlier cursors read as a gap', async () => {
        const events = new EventsExtension();
        const v1 = events.registerEvent('i', { emitOnly: true, payloadSchema: P });
        // Distinct arguments, so each poll has a lease of its own that no termination reached.
        const { poll } = poller(events);
        const { cursor: c0 } = await poll({ name: 'i', arguments: { k: 0 }, cursor: null });
        await v1.emit({ data: { n: 1 } });
        const { cursor: c1 } = await poll({ name: 'i', arguments: { k: 1 }, cursor: null });

        const v2 = events.registerEvent('i', { emitOnly: true, payloadSchema: z.object({ n: z.number(), v: z.literal(2) }) });
        expect(testHook(events).state().emitBuffer).toEqual({ i: 0 });
        expect(await poll({ name: 'i', arguments: { k: 2 }, cursor: c0 })).toMatchObject({ events: [], cursor: c1, truncated: true });
        await v2.emit({ data: { n: 2, v: 2 } });
        expect((await poll({ name: 'i', arguments: { k: 3 }, cursor: c1 })).events.map(event => event.data)).toEqual([{ n: 2, v: 2 }]);

        v2.remove();
        expect(testHook(events).state().emitBuffer).toEqual({ i: 0 });
        events.registerEvent('i', { emitOnly: true, payloadSchema: P });
        expect(await poll({ name: 'i', arguments: { k: 4 }, cursor: c1 })).toMatchObject({ events: [], truncated: true });
    });

    it('rejects emit() on a handle whose registration was removed', async () => {
        const events = new EventsExtension();
        const h = events.registerEvent('i', { emitOnly: true, payloadSchema: P });
        h.remove();
        await expect(h.emit({ data: { n: 1 } })).rejects.toThrow("event 'i': this handle's registration was removed or replaced");
        expect(testHook(events).state().emitBuffer).toEqual({});
    });
});

describe('events/poll errors', () => {
    it('answers -32601 to a legacy poll', async () => {
        const events = new EventsExtension();
        events.registerEvent('t', { payloadSchema: P, check: tick });
        const reply = await serve(events).rpc('events/poll', { name: 't', cursor: null }, { era: 'legacy' });
        expect(errorOf(reply)).toMatchObject({ code: -32_601, message: 'Method not found' });
    });

    it('maps errors to SEP codes', async () => {
        const onSubscribe = vi.fn();
        const events = new EventsExtension({ maxSubscriptions: 1 });
        events.registerEvent('t', { inputSchema: z.object({ a: z.number().optional() }), payloadSchema: P, check: tick, onSubscribe });
        events.registerEvent('push-only', { payloadSchema: P, check: tick, delivery: { poll: false } });
        const { fail, poll } = poller(events);
        expect(await fail({ name: 'missing' })).toMatchObject({ code: -32_023, data: { kind: 'event' } });
        expect(await fail({ name: 't', arguments: { a: 'x' } })).toMatchObject({ code: -32_602 });
        expect(await fail({ name: 'push-only' })).toMatchObject({ code: -32_026, data: { feature: 'deliveryMode', value: 'poll' } });
        await poll({ name: 't', arguments: { a: 1 } });
        expect(await fail({ name: 't', arguments: { a: 2 } })).toMatchObject({ code: -32_025, data: { limit: 'subscriptions' } });
        expect(onSubscribe).toHaveBeenCalledOnce();
        await poll({ name: 't', arguments: { a: 1 } });
    });

    it('answers -32023 after remove()', async () => {
        const events = new EventsExtension();
        const handle = events.registerEvent('t', { payloadSchema: P, check: tick });
        const { fail, poll } = poller(events);
        await poll({ name: 't' });
        handle.remove();
        expect(await fail({ name: 't' })).toMatchObject({ code: -32_023, data: { kind: 'event' } });
    });

    it('refuses the subscription when onSubscribe throws and keeps no lease', async () => {
        const onSubscribe = vi
            .fn()
            .mockImplementationOnce(() => {
                throw new EventsError('forbidden', 'Forbidden', { reason: 'sync' });
            })
            .mockRejectedValueOnce(new EventsError('forbidden', 'Forbidden', { reason: 'async' }));
        const events = new EventsExtension();
        events.registerEvent('t', { payloadSchema: P, check: tick, onSubscribe });
        const { fail, poll } = poller(events);
        expect(await fail({ name: 't' })).toMatchObject({ code: -32_024, data: { reason: 'sync' } });
        expect(await fail({ name: 't' })).toMatchObject({ code: -32_024, data: { reason: 'async' } });
        await poll({ name: 't' });
        expect(onSubscribe).toHaveBeenCalledTimes(3);
    });
});

describe('poll leases', () => {
    it('keeps one lease for the same arguments in any key order (Review Focus 4)', async () => {
        const onSubscribe = vi.fn();
        const events = new EventsExtension();
        events.registerEvent('t', { payloadSchema: P, check: tick, onSubscribe });
        const { poll } = poller(events);
        await poll({ name: 't', arguments: { a: 1, b: 2 } });
        await poll({ name: 't', arguments: { b: 2, a: 1 } });
        expect(onSubscribe).toHaveBeenCalledOnce();
        expect(onSubscribe.mock.calls[0]![0]).toMatchObject({ name: 't', mode: 'poll', principal: null });
        expect(onSubscribe.mock.calls[0]![1]).toEqual({ a: 1, b: 2 });
        await poll({ name: 't', arguments: { a: 1 } });
        expect(onSubscribe).toHaveBeenCalledTimes(2);
    });

    it('keys a lease by a digest of the canonical (principal, name, arguments), whose length does not grow with the arguments', async () => {
        const padded = await leaseKey('u1', 't', { a: 1, pad: 'x'.repeat(60_000) });
        expect(padded).toHaveLength((await leaseKey(null, 't', {})).length);
        expect(padded).not.toContain('xxxx');
        expect(await leaseKey('u1', 't', { a: 1, b: 2 })).toBe(await leaseKey('u1', 't', { b: 2, a: 1 }));
        expect(await leaseKey(null, 't', {})).not.toBe(await leaseKey('', 't', {}));
    });

    it('keys leases by principal', async () => {
        const onSubscribe = vi.fn();
        const events = new EventsExtension({ getPrincipal: ctx => (ctx.http?.authInfo?.extra?.sub as string | undefined) ?? null });
        events.registerEvent('t', { payloadSchema: P, check: tick, onSubscribe });
        const as = (sub: string) => poller(events, { authInfo: { token: 'tok', clientId: 'client', scopes: [], extra: { sub } } });
        await as('u1').poll({ name: 't' });
        await as('u1').poll({ name: 't' });
        await as('u2').poll({ name: 't' });
        expect(onSubscribe.mock.calls.map(([ctx]) => (ctx as EventContext).principal)).toEqual(['u1', 'u2']);
    });

    it('serves callers that share a lease as one subscription of a type without replay, as documented', async () => {
        const events = new EventsExtension();
        // An upstream without replay: each check(null) returns what happened since the previous call for the subscription.
        const happened: number[] = [];
        const read = new Map<string, number>();
        events.registerEvent('pulse', {
            payloadSchema: P,
            check: ctx => {
                const fresh = happened.slice(read.get(ctx.subscriptionId) ?? happened.length);
                read.set(ctx.subscriptionId, happened.length);
                return { events: fresh.map(n => ({ eventId: `e${n}`, data: { n } })), cursor: null };
            }
        });
        const ids = async (client: ReturnType<typeof poller>) => (await client.poll({ name: 'pulse' })).events.map(event => event.eventId);
        const [first, second] = [poller(events), poller(events)];

        expect(await ids(first)).toEqual([]);
        happened.push(1);
        // Without getPrincipal both share the lease: the second's first poll returns an event from before it subscribed.
        expect(await ids(second)).toEqual(['e1']);
        happened.push(2);
        expect(await ids(first)).toEqual(['e2']);
        expect(await ids(second)).toEqual([]);
        expect(read.size).toBe(1);
    });

    it('holds each principal to a quarter of maxSubscriptions, the callers without one together, freed as leases end', async () => {
        vi.useFakeTimers();
        const events = new EventsExtension({
            maxSubscriptions: 8,
            pollSubscriptionTtlMs: 10_000,
            defaultNextPollMs: 5000,
            getPrincipal: ctx => (ctx.http?.authInfo?.extra?.sub as string | undefined) ?? null
        });
        const handle = events.registerEvent('t', { payloadSchema: P, check: tick });
        const as = (sub: string | null) =>
            poller(events, sub === null ? {} : { authInfo: { token: 'tok', clientId: 'client', scopes: [], extra: { sub } } });
        const share = { code: -32_025, data: { limit: 'principalSubscriptions', max: 2 } };
        const [alice, bob, anonymous, other] = [as('alice'), as('bob'), as(null), as(null)];

        await alice.poll({ name: 't', arguments: { a: 1 } });
        await alice.poll({ name: 't', arguments: { a: 2 } });
        expect(await alice.fail({ name: 't', arguments: { a: 3 } })).toMatchObject(share);
        // A lease alice already holds still renews, and bob still subscribes.
        await alice.poll({ name: 't', arguments: { a: 1 } });
        await bob.poll({ name: 't', arguments: { a: 1 } });

        // Every caller without a principal shares one bucket.
        await anonymous.poll({ name: 't', arguments: { a: 1 } });
        await other.poll({ name: 't', arguments: { a: 2 } });
        expect(await anonymous.fail({ name: 't', arguments: { a: 3 } })).toMatchObject(share);

        // A terminated lease frees its place once its error is answered, and an expired one at its expiry.
        await handle.terminate(new EventsError('forbidden', 'Forbidden'));
        expect(await alice.fail({ name: 't', arguments: { a: 1 } })).toMatchObject({ code: -32_024 });
        await alice.poll({ name: 't', arguments: { a: 3 } });
        await vi.advanceTimersByTimeAsync(10_001);
        expect(testHook(events).state().pollLeases).toBe(0);
        await anonymous.poll({ name: 't', arguments: { a: 3 } });
        await anonymous.poll({ name: 't', arguments: { a: 4 } });
    });

    it('runs onSubscribe once for concurrent first polls of one lease', async () => {
        let release!: () => void;
        const onSubscribe = vi.fn(() => new Promise<void>(resolve => (release = resolve)));
        const check = vi.fn(tick);
        const events = new EventsExtension();
        events.registerEvent('t', { payloadSchema: P, check, onSubscribe });
        const { poll } = poller(events);
        const first = poll({ name: 't', cursor: 'h0' });
        const second = poll({ name: 't', cursor: 'h0' });
        await vi.waitFor(() => expect(onSubscribe).toHaveBeenCalledOnce());
        expect(check).not.toHaveBeenCalled();
        release();
        await expect(Promise.all([first, second])).resolves.toHaveLength(2);
        expect(onSubscribe).toHaveBeenCalledOnce();
        expect(check).toHaveBeenCalledTimes(2);
    });

    it('expires a lease and calls onUnsubscribe', async () => {
        vi.useFakeTimers();
        const onSubscribe = vi.fn();
        const onUnsubscribe = vi.fn();
        const events = new EventsExtension({ pollSubscriptionTtlMs: 300_000 });
        events.registerEvent('t', { payloadSchema: P, check: tick, onSubscribe, onUnsubscribe });
        const { poll } = poller(events);
        await poll({ name: 't', arguments: { a: 1 } });
        const subscribed = onSubscribe.mock.calls[0]![0] as EventContext;
        await vi.advanceTimersByTimeAsync(299_999);
        expect(onUnsubscribe).not.toHaveBeenCalled();
        expect(subscribed.signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(2);
        expect(onUnsubscribe).toHaveBeenCalledOnce();
        const [ctx, args] = onUnsubscribe.mock.calls[0]! as [EventContext, unknown];
        expect(ctx).toMatchObject({ name: 't', mode: 'poll', principal: null, subscriptionId: subscribed.subscriptionId });
        expect(ctx.signal.aborted).toBe(true);
        expect(subscribed.signal.aborted).toBe(true);
        expect(args).toEqual({ a: 1 });
    });

    it('renews a lease on every poll', async () => {
        vi.useFakeTimers();
        const onUnsubscribe = vi.fn();
        const events = new EventsExtension({ pollSubscriptionTtlMs: 300_000 });
        events.registerEvent('t', { payloadSchema: P, check: tick, onUnsubscribe });
        const { poll } = poller(events);
        await poll({ name: 't' });
        await vi.advanceTimersByTimeAsync(200_000);
        await poll({ name: 't' });
        await vi.advanceTimersByTimeAsync(200_000);
        expect(onUnsubscribe).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(100_001);
        expect(onUnsubscribe).toHaveBeenCalledOnce();
    });

    it('reports a failing onUnsubscribe on expiry', async () => {
        vi.useFakeTimers();
        const onerror = vi.fn();
        const events = new EventsExtension({ onerror, pollSubscriptionTtlMs: 1000 });
        events.registerEvent('t', {
            payloadSchema: P,
            check: tick,
            onUnsubscribe: () => {
                throw new Error('teardown failed');
            }
        });
        await poller(events).poll({ name: 't' });
        await vi.advanceTimersByTimeAsync(1001);
        expect(onerror).toHaveBeenCalledWith(expect.objectContaining({ message: 'teardown failed' }));
    });

    it('delivers a termination on the next poll', async () => {
        const onSubscribe = vi.fn();
        const onUnsubscribe = vi.fn();
        const events = new EventsExtension();
        const handle = events.registerEvent('t', { payloadSchema: P, check: tick, onSubscribe, onUnsubscribe });
        const { fail, poll } = poller(events);
        await poll({ name: 't' });
        await handle.terminate(new EventsError('forbidden', 'Forbidden', { reason: 'Access revoked' }));
        expect(onUnsubscribe).toHaveBeenCalledOnce();
        expect((onUnsubscribe.mock.calls[0]![0] as EventContext).signal.aborted).toBe(true);
        expect(await fail({ name: 't' })).toEqual({ code: -32_024, message: 'Forbidden', data: { reason: 'Access revoked' } });
        await poll({ name: 't' });
        expect(onSubscribe).toHaveBeenCalledTimes(2);
        expect(onUnsubscribe).toHaveBeenCalledOnce();
    });

    it('terminates only the lease with the given subscriptionId', async () => {
        const ids = new Map<number, string>();
        const events = new EventsExtension();
        const handle = events.registerEvent('t', {
            inputSchema: z.object({ a: z.number() }),
            payloadSchema: P,
            check: tick,
            onSubscribe: (ctx, args) => {
                ids.set(args.a, ctx.subscriptionId);
            }
        });
        const { fail, poll } = poller(events);
        await poll({ name: 't', arguments: { a: 1 } });
        await poll({ name: 't', arguments: { a: 2 } });
        await handle.terminate(new EventsError('forbidden', 'Forbidden'), { subscriptionId: ids.get(2)! });
        await poll({ name: 't', arguments: { a: 1 } });
        expect(await fail({ name: 't', arguments: { a: 2 } })).toMatchObject({ code: -32_024 });
    });

    it('answers a schema change with -32026 even when the old arguments no longer parse (D18)', async () => {
        const events = new EventsExtension();
        events.registerEvent('t', { inputSchema: z.object({ a: z.number() }), payloadSchema: P, check: tick });
        const { fail, poll } = poller(events);
        await poll({ name: 't', arguments: { a: 1 } });
        events.registerEvent('t', { inputSchema: z.object({ b: z.string() }), payloadSchema: P, check: tick });
        expect(await fail({ name: 't', arguments: { a: 1 } })).toMatchObject({
            code: -32_026,
            data: { feature: 'inputSchema', reason: 'schema_changed' }
        });
        expect(await fail({ name: 't', arguments: { a: 1 } })).toMatchObject({ code: -32_602 });
    });
});

describe('test hook', () => {
    it('reports the emit buffer and poll leases, and restart() clears both', async () => {
        const onSubscribe = vi.fn();
        const events = new EventsExtension();
        const h = events.registerEvent('i', { emitOnly: true, payloadSchema: P, onSubscribe });
        const hook = testHook(events);
        const { poll } = poller(events);
        const { cursor: c0 } = await poll({ name: 'i', cursor: null });
        await h.emit({ data: { n: 1 } });
        expect(hook.state()).toEqual({
            trustedOrigins: [],
            emitBuffer: { i: 1 },
            pollLeases: 1,
            pushStreams: 0,
            webhookSubscriptions: 0,
            webhookExpiryTimers: 0
        });

        hook.restart();
        expect(hook.state()).toEqual({
            trustedOrigins: [],
            emitBuffer: {},
            pollLeases: 0,
            pushStreams: 0,
            webhookSubscriptions: 0,
            webhookExpiryTimers: 0
        });
        const after = await poll({ name: 'i', cursor: c0 });
        expect(after).toMatchObject({ events: [], truncated: true, hasMore: false });
        expect(after.cursor).not.toBe(c0);
        expect(onSubscribe).toHaveBeenCalledTimes(2);
    });
});
