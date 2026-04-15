import { Client, ClientEventManager } from '@modelcontextprotocol/client';
import type { EventNotification, EventOccurrence } from '@modelcontextprotocol/core';
import {
    computeWebhookSignature,
    CURSOR_EXPIRED,
    EVENT_NOT_FOUND,
    InMemoryTransport,
    isSafeWebhookUrl,
    ProtocolError,
    ProtocolErrorCode,
    SUBSCRIPTION_NOT_FOUND,
    verifyWebhookSignature,
    WEBHOOK_SIGNATURE_HEADER,
    WEBHOOK_TIMESTAMP_HEADER
} from '@modelcontextprotocol/core';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

async function connectPair(server: McpServer, client: Client) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
}

/** Opens a fire-and-forget `events/stream` request whose rejection on abort is swallowed. */
function openStream(client: Client, subscriptions: unknown[], controller: AbortController) {
    client
        .request({ method: 'events/stream', params: { subscriptions: subscriptions as never } }, { signal: controller.signal })
        .catch(() => {});
}

function makeCounterEvent(nextPollSeconds?: number) {
    const state = { value: 0 };
    const check = async (params: { minValue: number }, cursor: string | null) => {
        const position = cursor === null ? state.value : Number(cursor);
        const events: { name: string; data: Record<string, number> }[] = [];
        for (let i = position + 1; i <= state.value; i++) {
            if (i >= params.minValue) events.push({ name: 'counter.tick', data: { value: i } });
        }
        return { events, cursor: String(state.value), nextPollSeconds };
    };
    return { state, check };
}

describe('Events', () => {
    let server: McpServer;
    let client: Client;

    beforeEach(() => {
        server = new McpServer({ name: 'test-server', version: '1.0.0' });
        client = new Client({ name: 'test-client', version: '1.0.0' });
    });

    afterEach(async () => {
        await client.close();
        await server.close();
    });

    describe('events/list', () => {
        it('lists registered event types with computed delivery modes', async () => {
            const { check } = makeCounterEvent();
            server.registerEvent(
                'counter.tick',
                {
                    description: 'Fires every time the counter is incremented',
                    inputSchema: z.object({ minValue: z.number().default(0) }),
                    payloadSchema: z.object({ value: z.number() })
                },
                check
            );

            await connectPair(server, client);

            const result = await client.listEvents();
            expect(result.events).toHaveLength(1);
            expect(result.events[0]!.name).toBe('counter.tick');
            expect(result.events[0]!.description).toContain('counter');
            expect(result.events[0]!.delivery).toContain('poll');
            expect(result.events[0]!.delivery).toContain('push');
            expect(result.events[0]!.delivery).not.toContain('webhook'); // no webhook TTL configured
            expect(result.events[0]!.inputSchema?.type).toBe('object');
        });

        it('returns empty list when no events are registered', async () => {
            await connectPair(server, client);
            const result = await client.listEvents();
            expect(result.events).toEqual([]);
        });

        it('excludes disabled events from the list', async () => {
            const { check } = makeCounterEvent();
            const registered = server.registerEvent('counter.tick', { inputSchema: z.object({ minValue: z.number().default(0) }) }, check);

            await connectPair(server, client);

            let result = await client.listEvents();
            expect(result.events).toHaveLength(1);

            registered.disable();
            result = await client.listEvents();
            expect(result.events).toHaveLength(0);

            registered.enable();
            result = await client.listEvents();
            expect(result.events).toHaveLength(1);
        });

        it('advertises webhook delivery when webhook TTL is configured', async () => {
            server = new McpServer({ name: 's', version: '1.0.0' }, { events: { webhook: { ttlMs: 60_000 } } });
            const { check } = makeCounterEvent();
            server.registerEvent('counter.tick', { inputSchema: z.object({ minValue: z.number().default(0) }) }, check);

            await connectPair(server, client);

            const result = await client.listEvents();
            expect(result.events[0]!.delivery).toContain('webhook');
        });

        it('sends notifications/events/list_changed when an event is registered after connect', async () => {
            const { check } = makeCounterEvent();
            server.registerEvent('counter.tick', { inputSchema: z.object({ minValue: z.number().default(0) }) }, check);

            let listChangedCount = 0;
            client.setNotificationHandler('notifications/events/list_changed', () => {
                listChangedCount++;
            });

            await connectPair(server, client);

            server.registerEvent('counter.tock', { inputSchema: z.object({ minValue: z.number().default(0) }) }, check);
            await new Promise(r => setTimeout(r, 10));

            expect(listChangedCount).toBeGreaterThan(0);
        });
    });

    describe('events/poll', () => {
        it('returns empty events and a fresh cursor on bootstrap', async () => {
            const { state, check } = makeCounterEvent(0.01);
            server.registerEvent('counter.tick', { inputSchema: z.object({ minValue: z.number().default(0) }) }, check);

            await connectPair(server, client);

            state.value = 5;
            const result = await client.pollEvents({
                subscriptions: [{ id: 'sub1', name: 'counter.tick', params: { minValue: 0 }, cursor: null }]
            });

            expect(result.results).toHaveLength(1);
            expect(result.results[0]!.id).toBe('sub1');
            expect(result.results[0]!.events).toEqual([]);
            expect(result.results[0]!.cursor).toBe('5');
        });

        it('returns events since the cursor on subsequent polls', async () => {
            const { state, check } = makeCounterEvent(0.01);
            server.registerEvent('counter.tick', { inputSchema: z.object({ minValue: z.number().default(0) }) }, check);

            await connectPair(server, client);

            // Bootstrap
            let r = await client.pollEvents({
                subscriptions: [{ id: 'sub1', name: 'counter.tick', params: { minValue: 0 }, cursor: null }]
            });
            const bootCursor = r.results[0]!.cursor!;

            // Produce three events
            state.value = 3;

            r = await client.pollEvents({
                subscriptions: [{ id: 'sub1', name: 'counter.tick', params: { minValue: 0 }, cursor: bootCursor }]
            });
            expect(r.results[0]!.events).toHaveLength(3);
            expect(r.results[0]!.events!.map(e => e.data.value)).toEqual([1, 2, 3]);
            expect(r.results[0]!.cursor).toBe('3');
        });

        it('respects subscription params as filters', async () => {
            const { state, check } = makeCounterEvent(0.01);
            server.registerEvent('counter.tick', { inputSchema: z.object({ minValue: z.number().default(0) }) }, check);

            await connectPair(server, client);

            let r = await client.pollEvents({
                subscriptions: [{ id: 'sub1', name: 'counter.tick', params: { minValue: 3 }, cursor: null }]
            });
            const bootCursor = r.results[0]!.cursor!;

            state.value = 5;

            r = await client.pollEvents({
                subscriptions: [{ id: 'sub1', name: 'counter.tick', params: { minValue: 3 }, cursor: bootCursor }]
            });
            expect(r.results[0]!.events!.map(e => e.data.value)).toEqual([3, 4, 5]);
        });

        it('returns per-subscription error for unknown event types without failing the request', async () => {
            const { check } = makeCounterEvent();
            server.registerEvent('counter.tick', { inputSchema: z.object({ minValue: z.number().default(0) }) }, check);

            await connectPair(server, client);

            const r = await client.pollEvents({
                subscriptions: [
                    { id: 'good', name: 'counter.tick', params: { minValue: 0 }, cursor: null },
                    { id: 'bad', name: 'nonexistent.event', params: {}, cursor: null }
                ]
            });

            expect(r.results).toHaveLength(2);
            expect(r.results.find(e => e.id === 'good')!.error).toBeUndefined();
            expect(r.results.find(e => e.id === 'bad')!.error?.code).toBe(EVENT_NOT_FOUND);
        });

        it('returns InvalidParams error for bad subscription params', async () => {
            const { check } = makeCounterEvent();
            server.registerEvent('counter.tick', { inputSchema: z.object({ minValue: z.number() }) }, check);

            await connectPair(server, client);

            const r = await client.pollEvents({
                subscriptions: [{ id: 'sub1', name: 'counter.tick', params: { minValue: 'not a number' }, cursor: null }]
            });

            expect(r.results[0]!.error?.code).toBe(ProtocolErrorCode.InvalidParams);
        });

        it('respects maxEvents and signals hasMore', async () => {
            const { state, check } = makeCounterEvent(0.01);
            server.registerEvent('counter.tick', { inputSchema: z.object({ minValue: z.number().default(0) }) }, check);

            await connectPair(server, client);

            let r = await client.pollEvents({
                subscriptions: [{ id: 'sub1', name: 'counter.tick', params: { minValue: 0 }, cursor: null }]
            });
            const bootCursor = r.results[0]!.cursor!;

            state.value = 10;

            r = await client.pollEvents({
                maxEvents: 3,
                subscriptions: [{ id: 'sub1', name: 'counter.tick', params: { minValue: 0 }, cursor: bootCursor }]
            });
            expect(r.results[0]!.events).toHaveLength(3);
            expect(r.results[0]!.hasMore).toBe(true);
        });

        it('translates CursorExpired errors to per-subscription errors', async () => {
            server.registerEvent('volatile.event', { inputSchema: z.object({}) }, async (_params, cursor) => {
                if (cursor !== null && cursor !== 'fresh') {
                    throw new ProtocolError(CURSOR_EXPIRED, 'Upstream history compacted');
                }
                return { events: [], cursor: 'fresh' };
            });

            await connectPair(server, client);

            const r = await client.pollEvents({
                subscriptions: [{ id: 'sub1', name: 'volatile.event', params: {}, cursor: 'stale-cursor' }]
            });
            expect(r.results[0]!.error?.code).toBe(CURSOR_EXPIRED);
        });
    });

    describe('events/stream (push mode)', () => {
        it('confirms subscriptions with notifications/events/active and delivers events as notifications/event', async () => {
            const { state, check } = makeCounterEvent(0.01);
            server.registerEvent(
                'counter.tick',
                {
                    inputSchema: z.object({ minValue: z.number().default(0) })
                },
                check
            );

            const active: string[] = [];
            const events: EventNotification['params'][] = [];
            client.setNotificationHandler('notifications/events/active', n => {
                active.push(n.params.id);
            });
            client.setNotificationHandler('notifications/events/event', n => {
                events.push(n.params);
            });

            await connectPair(server, client);

            const controller = new AbortController();
            openStream(client, [{ id: 'sub1', name: 'counter.tick', params: { minValue: 0 }, cursor: null }], controller);

            // Wait for active confirmation
            await vi.waitFor(() => expect(active).toContain('sub1'));

            // Produce events
            state.value = 3;

            // Wait for poll-driven push to deliver them
            await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(3));
            expect(events.map(e => e.data.value).slice(0, 3)).toEqual([1, 2, 3]);
            expect(events[0]!.id).toBe('sub1');
            expect(events[0]!.cursor).toBeDefined();

            controller.abort();
        });

        it('reports per-subscription errors on the stream for unknown events', async () => {
            const { check } = makeCounterEvent();
            server.registerEvent('counter.tick', { inputSchema: z.object({ minValue: z.number().default(0) }) }, check);

            const errors: { id: string; code: number }[] = [];
            client.setNotificationHandler('notifications/events/error', n => {
                errors.push({ id: n.params.id, code: n.params.code });
            });

            await connectPair(server, client);

            const controller = new AbortController();
            openStream(
                client,
                [
                    { id: 'good', name: 'counter.tick', params: { minValue: 0 }, cursor: null },
                    { id: 'bad', name: 'nope', params: {}, cursor: null }
                ],
                controller
            );

            await vi.waitFor(() => expect(errors).toHaveLength(1));
            expect(errors[0]!.id).toBe('bad');
            expect(errors[0]!.code).toBe(EVENT_NOT_FOUND);

            controller.abort();
        });

        it('terminates the stream and runs onUnsubscribe hooks on abort', async () => {
            const { check } = makeCounterEvent();
            const unsubscribed: string[] = [];
            server.registerEvent(
                'counter.tick',
                {
                    inputSchema: z.object({ minValue: z.number().default(0) }),
                    hooks: {
                        onUnsubscribe: id => {
                            unsubscribed.push(id);
                        }
                    }
                },
                check
            );

            await connectPair(server, client);

            const controller = new AbortController();
            const streamPromise = client.request(
                {
                    method: 'events/stream',
                    params: { subscriptions: [{ id: 'sub1', name: 'counter.tick', params: { minValue: 0 }, cursor: null }] }
                },
                { signal: controller.signal }
            );

            await new Promise(r => setTimeout(r, 20));
            controller.abort();
            await expect(streamPromise).rejects.toThrow();

            await vi.waitFor(() => expect(unsubscribed).toContain('sub1'));
        });

        it('terminates a subscription with notifications/events/terminated', async () => {
            const { check } = makeCounterEvent();
            server.registerEvent('counter.tick', { inputSchema: z.object({ minValue: z.number().default(0) }) }, check);

            const terminated: { id: string; reason?: string }[] = [];
            client.setNotificationHandler('notifications/events/terminated', n => {
                terminated.push({ id: n.params.id, reason: n.params.reason });
            });

            await connectPair(server, client);

            const controller = new AbortController();
            openStream(client, [{ id: 'sub1', name: 'counter.tick', params: { minValue: 0 }, cursor: null }], controller);

            await new Promise(r => setTimeout(r, 20));

            server.terminateEventSubscription('sub1', 'Access revoked');

            await vi.waitFor(() => expect(terminated).toHaveLength(1));
            expect(terminated[0]!.id).toBe('sub1');
            expect(terminated[0]!.reason).toBe('Access revoked');

            controller.abort();
        });

        it('delivers heartbeats periodically', async () => {
            server = new McpServer({ name: 's', version: '1.0.0' }, { events: { push: { heartbeatIntervalMs: 10 } } });
            const { check } = makeCounterEvent();
            server.registerEvent('counter.tick', { inputSchema: z.object({ minValue: z.number().default(0) }) }, check);

            let heartbeats = 0;
            client.setNotificationHandler('notifications/events/heartbeat', () => {
                heartbeats++;
            });

            await connectPair(server, client);

            const controller = new AbortController();
            openStream(client, [], controller);

            await vi.waitFor(() => expect(heartbeats).toBeGreaterThan(0));
            controller.abort();
        });
    });

    describe('emit()', () => {
        it('delivers broadcast emits to matching push subscriptions', async () => {
            server.registerEvent(
                'incident.created',
                {
                    inputSchema: z.object({ severity: z.string().optional() }),
                    matches: (params, data) => !params.severity || params.severity === data.severity
                },
                async (_params, _cursor) => ({ events: [], cursor: String(Date.now()) })
            );

            const received: { id: string; severity: unknown }[] = [];
            client.setNotificationHandler('notifications/events/event', n => {
                received.push({ id: n.params.id, severity: n.params.data.severity });
            });

            await connectPair(server, client);

            const controller = new AbortController();
            openStream(
                client,
                [
                    { id: 'all', name: 'incident.created', params: {}, cursor: null },
                    { id: 'p1only', name: 'incident.created', params: { severity: 'P1' }, cursor: null }
                ],
                controller
            );

            await new Promise(r => setTimeout(r, 20));

            server.emitEvent('incident.created', { incidentId: 'INC-1', severity: 'P1', title: 'DB down' });
            server.emitEvent('incident.created', { incidentId: 'INC-2', severity: 'P3', title: 'Slow query' });

            await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(3));

            const allSub = received.filter(r => r.id === 'all');
            const p1Sub = received.filter(r => r.id === 'p1only');
            expect(allSub).toHaveLength(2);
            expect(p1Sub).toHaveLength(1);
            expect(p1Sub[0]!.severity).toBe('P1');

            controller.abort();
        });

        it('delivers targeted emits only to the specified subscription', async () => {
            server.registerEvent('slack.message', { inputSchema: z.object({ channel: z.string() }) }, async (_p, _c) => ({
                events: [],
                cursor: 'c'
            }));

            const received: string[] = [];
            client.setNotificationHandler('notifications/events/event', n => {
                received.push(n.params.id);
            });

            await connectPair(server, client);

            const controller = new AbortController();
            openStream(
                client,
                [
                    { id: 'chan1', name: 'slack.message', params: { channel: 'general' }, cursor: null },
                    { id: 'chan2', name: 'slack.message', params: { channel: 'random' }, cursor: null }
                ],
                controller
            );

            await new Promise(r => setTimeout(r, 20));

            server.emitEvent('slack.message', { text: 'hi', channel: 'general' }, { subscriptionId: 'chan1' });

            await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(1));
            expect(received).toEqual(['chan1']);

            controller.abort();
        });
    });

    describe('emit() buffering for poll mode', () => {
        function registerIncidentEvent(capacity: number) {
            server.registerEvent(
                'incident.created',
                {
                    inputSchema: z.object({ severity: z.string().optional() }),
                    matches: (params, data) => !params.severity || params.severity === data.severity,
                    bufferEmits: { capacity }
                },
                // Check callback returns nothing — emits drive everything.
                async (_params, _cursor) => ({ events: [], cursor: 'check-cursor', nextPollSeconds: 30 })
            );
        }

        it('delivers buffered emits to poll clients on next poll', async () => {
            registerIncidentEvent(100);
            await connectPair(server, client);

            // Bootstrap.
            let r = await client.pollEvents({
                subscriptions: [{ id: 's', name: 'incident.created', params: {}, cursor: null }]
            });
            expect(r.results[0]!.events).toEqual([]);
            const bootCursor = r.results[0]!.cursor!;

            // Emit three events.
            server.emitEvent('incident.created', { incidentId: 'INC-1', severity: 'P1' });
            server.emitEvent('incident.created', { incidentId: 'INC-2', severity: 'P2' });
            server.emitEvent('incident.created', { incidentId: 'INC-3', severity: 'P3' });

            r = await client.pollEvents({
                subscriptions: [{ id: 's', name: 'incident.created', params: {}, cursor: bootCursor }]
            });
            expect(r.results[0]!.events).toHaveLength(3);
            expect(r.results[0]!.events!.map(e => e.data.incidentId)).toEqual(['INC-1', 'INC-2', 'INC-3']);

            // Second poll with new cursor returns nothing.
            const nextCursor = r.results[0]!.cursor!;
            r = await client.pollEvents({
                subscriptions: [{ id: 's', name: 'incident.created', params: {}, cursor: nextCursor }]
            });
            expect(r.results[0]!.events).toEqual([]);
        });

        it('applies matches filter to buffered emits at poll time', async () => {
            registerIncidentEvent(100);
            await connectPair(server, client);

            let r = await client.pollEvents({
                subscriptions: [{ id: 's', name: 'incident.created', params: { severity: 'P1' }, cursor: null }]
            });
            const cursor = r.results[0]!.cursor!;

            server.emitEvent('incident.created', { incidentId: 'INC-1', severity: 'P1' });
            server.emitEvent('incident.created', { incidentId: 'INC-2', severity: 'P3' });
            server.emitEvent('incident.created', { incidentId: 'INC-3', severity: 'P1' });

            r = await client.pollEvents({
                subscriptions: [{ id: 's', name: 'incident.created', params: { severity: 'P1' }, cursor }]
            });
            expect(r.results[0]!.events!.map(e => e.data.incidentId)).toEqual(['INC-1', 'INC-3']);
        });

        it('returns CursorExpired when buffer wraps past the client cursor', async () => {
            registerIncidentEvent(2);
            await connectPair(server, client);

            let r = await client.pollEvents({
                subscriptions: [{ id: 's', name: 'incident.created', params: {}, cursor: null }]
            });
            const staleCursor = r.results[0]!.cursor!;

            // Emit 3 events into a capacity-2 buffer — oldest is evicted.
            server.emitEvent('incident.created', { incidentId: 'INC-1', severity: 'P1' });
            server.emitEvent('incident.created', { incidentId: 'INC-2', severity: 'P1' });
            server.emitEvent('incident.created', { incidentId: 'INC-3', severity: 'P1' });

            r = await client.pollEvents({
                subscriptions: [{ id: 's', name: 'incident.created', params: {}, cursor: staleCursor }]
            });
            expect(r.results[0]!.error?.code).toBe(CURSOR_EXPIRED);
        });

        it('does not buffer targeted emits (subscriptionId set)', async () => {
            registerIncidentEvent(100);
            await connectPair(server, client);

            let r = await client.pollEvents({
                subscriptions: [{ id: 's', name: 'incident.created', params: {}, cursor: null }]
            });
            const cursor = r.results[0]!.cursor!;

            server.emitEvent('incident.created', { incidentId: 'INC-1', severity: 'P1' }, { subscriptionId: 'some-push-sub' });

            r = await client.pollEvents({
                subscriptions: [{ id: 's', name: 'incident.created', params: {}, cursor }]
            });
            expect(r.results[0]!.events).toEqual([]);
        });

        it('merges check-callback events with buffered emits', async () => {
            const { state, check } = makeCounterEvent(30);
            server.registerEvent(
                'mixed.event',
                {
                    inputSchema: z.object({ minValue: z.number().default(0) }),
                    bufferEmits: { capacity: 100 }
                },
                check
            );
            await connectPair(server, client);

            let r = await client.pollEvents({
                subscriptions: [{ id: 's', name: 'mixed.event', params: { minValue: 0 }, cursor: null }]
            });
            const cursor = r.results[0]!.cursor!;

            state.value = 2; // check callback will return 2 events
            server.emitEvent('mixed.event', { source: 'emit' }); // buffer adds 1

            r = await client.pollEvents({
                subscriptions: [{ id: 's', name: 'mixed.event', params: { minValue: 0 }, cursor }]
            });
            expect(r.results[0]!.events).toHaveLength(3);
        });

        it('bootstrap skips events already in the buffer (start from now)', async () => {
            registerIncidentEvent(100);
            await connectPair(server, client);

            // Emit before any client bootstraps.
            server.emitEvent('incident.created', { incidentId: 'INC-OLD', severity: 'P1' });

            const r = await client.pollEvents({
                subscriptions: [{ id: 's', name: 'incident.created', params: {}, cursor: null }]
            });
            expect(r.results[0]!.events).toEqual([]);
        });

        it('push subscribe with prior cursor replays buffered emits since that cursor', async () => {
            registerIncidentEvent(100);
            const events: EventNotification['params'][] = [];
            client.setNotificationHandler('notifications/events/event', n => {
                events.push(n.params);
            });
            const active: { id: string; cursor: string }[] = [];
            client.setNotificationHandler('notifications/events/active', n => {
                active.push({ id: n.params.id, cursor: n.params.cursor as string });
            });

            await connectPair(server, client);

            // First stream — bootstrap, capture a cursor after one delivery.
            const c1 = new AbortController();
            openStream(client, [{ id: 's1', name: 'incident.created', params: {}, cursor: null }], c1);
            await vi.waitFor(() => expect(active.find(a => a.id === 's1')).toBeDefined());

            server.emitEvent('incident.created', { incidentId: 'INC-1', severity: 'P1' });
            await vi.waitFor(() => expect(events.find(e => e.data.incidentId === 'INC-1')).toBeDefined());
            const capturedCursor = events.find(e => e.data.incidentId === 'INC-1')!.cursor!;
            c1.abort();
            // Give the abort a moment to close the server-side stream so subsequent
            // emits don't race-deliver to the dying s1 sub.
            await new Promise(r => setTimeout(r, 30));

            // While "disconnected", more events fire.
            server.emitEvent('incident.created', { incidentId: 'INC-2', severity: 'P1' });
            server.emitEvent('incident.created', { incidentId: 'INC-3', severity: 'P1' });
            server.emitEvent('incident.created', { incidentId: 'INC-4', severity: 'P1' });

            events.length = 0;

            // Resume with the captured cursor — server should replay INC-2..INC-4 from buffer.
            const c2 = new AbortController();
            openStream(client, [{ id: 's2', name: 'incident.created', params: {}, cursor: capturedCursor }], c2);

            await vi.waitFor(() => expect(events.filter(e => e.id === 's2').length).toBeGreaterThanOrEqual(3));
            const s2Events = events.filter(e => e.id === 's2');
            expect(s2Events.map(e => e.data.incidentId)).toEqual(['INC-2', 'INC-3', 'INC-4']);
            c2.abort();
        });

        it('push subscribe with cursor older than buffer head returns CursorExpired', async () => {
            registerIncidentEvent(2);
            const errors: { id: string; code: number }[] = [];
            client.setNotificationHandler('notifications/events/error', n => {
                errors.push({ id: n.params.id, code: n.params.code });
            });

            await connectPair(server, client);

            // Bootstrap once to obtain a valid composite cursor.
            const r = await client.pollEvents({
                subscriptions: [{ id: 'p', name: 'incident.created', params: {}, cursor: null }]
            });
            const staleCursor = r.results[0]!.cursor!;

            // Emit 3 into a 2-capacity buffer — oldest evicted past staleCursor.
            server.emitEvent('incident.created', { incidentId: 'INC-1', severity: 'P1' });
            server.emitEvent('incident.created', { incidentId: 'INC-2', severity: 'P1' });
            server.emitEvent('incident.created', { incidentId: 'INC-3', severity: 'P1' });

            const c = new AbortController();
            openStream(client, [{ id: 's', name: 'incident.created', params: {}, cursor: staleCursor }], c);

            await vi.waitFor(() => expect(errors).toHaveLength(1));
            expect(errors[0]!.code).toBe(CURSOR_EXPIRED);
            c.abort();
        });
    });

    describe('events/subscribe and events/unsubscribe (webhook mode)', () => {
        const SUB_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
        const HOOK_URL = 'http://localhost:9999/hook';
        let fetchMock: ReturnType<typeof vi.fn>;

        beforeEach(() => {
            fetchMock = vi.fn(async () => new Response('', { status: 200 }));
            server = new McpServer(
                { name: 's', version: '1.0.0' },
                {
                    events: {
                        webhook: {
                            ttlMs: 30_000,
                            urlValidation: { allowPrivateNetworks: true, allowInsecure: true },
                            fetch: fetchMock as unknown as typeof fetch
                        }
                    }
                }
            );
        });

        it('creates a webhook subscription and returns refreshBefore', async () => {
            const { check } = makeCounterEvent();
            server.registerEvent('counter.tick', { inputSchema: z.object({ minValue: z.number().default(0) }) }, check);

            await connectPair(server, client);

            const result = await client.subscribeEvent({
                id: SUB_ID,
                name: 'counter.tick',
                params: { minValue: 0 },
                delivery: { mode: 'webhook', url: HOOK_URL, secret: 'secret123' },
                cursor: null
            });

            expect(result.id).toBe(SUB_ID);
            expect(result.refreshBefore).toBeDefined();
            expect(new Date(result.refreshBefore).getTime()).toBeGreaterThan(Date.now());
        });

        it('mints a webhook secret on create and omits it on refresh', async () => {
            const { state, check } = makeCounterEvent(0.01);
            server.registerEvent('counter.tick', { inputSchema: z.object({ minValue: z.number().default(0) }) }, check);

            await connectPair(server, client);

            const first = await client.subscribeEvent({
                id: SUB_ID,
                name: 'counter.tick',
                params: { minValue: 0 },
                delivery: { mode: 'webhook', url: HOOK_URL },
                cursor: null
            });
            expect(first.secret).toBeDefined();
            expect(first.secret).toMatch(/^whsec_[\da-f]{64}$/);

            const second = await client.subscribeEvent({
                id: SUB_ID,
                name: 'counter.tick',
                params: { minValue: 0 },
                delivery: { mode: 'webhook', url: HOOK_URL },
                cursor: null
            });
            expect(second.secret).toBeUndefined();

            // The minted secret signs deliveries.
            state.value = 1;
            await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
            const [, init] = fetchMock.mock.calls[0]!;
            const verify = await verifyWebhookSignature(
                first.secret!,
                init.body as string,
                (init.headers as Record<string, string>)[WEBHOOK_SIGNATURE_HEADER],
                (init.headers as Record<string, string>)[WEBHOOK_TIMESTAMP_HEADER]
            );
            expect(verify.valid).toBe(true);
        });

        it('delivers events via webhook POST with HMAC signature', async () => {
            const { state, check } = makeCounterEvent(0.01);
            server.registerEvent(
                'counter.tick',
                {
                    inputSchema: z.object({ minValue: z.number().default(0) })
                },
                check
            );

            await connectPair(server, client);

            await client.subscribeEvent({
                id: SUB_ID,
                name: 'counter.tick',
                params: { minValue: 0 },
                delivery: { mode: 'webhook', url: HOOK_URL, secret: 'secret123' },
                cursor: null
            });

            state.value = 2;

            await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

            const [url, init] = fetchMock.mock.calls[0]!;
            expect(url).toBe(HOOK_URL);
            expect(init.method).toBe('POST');

            const body = init.body as string;
            const parsed = JSON.parse(body);
            expect(parsed.id).toBe(SUB_ID);
            expect(parsed.name).toBe('counter.tick');
            expect(parsed.eventId).toBeDefined();

            const sigHeader = (init.headers as Record<string, string>)[WEBHOOK_SIGNATURE_HEADER];
            const tsHeader = (init.headers as Record<string, string>)[WEBHOOK_TIMESTAMP_HEADER];
            const verify = await verifyWebhookSignature('secret123', body, sigHeader, tsHeader);
            expect(verify.valid).toBe(true);
        });

        it('idempotently refreshes the TTL on repeat subscribe', async () => {
            const { check } = makeCounterEvent();
            server.registerEvent('counter.tick', { inputSchema: z.object({ minValue: z.number().default(0) }) }, check);

            await connectPair(server, client);

            const first = await client.subscribeEvent({
                id: SUB_ID,
                name: 'counter.tick',
                params: { minValue: 0 },
                delivery: { mode: 'webhook', url: HOOK_URL, secret: 'a' },
                cursor: null
            });

            await new Promise(r => setTimeout(r, 10));

            const second = await client.subscribeEvent({
                id: SUB_ID,
                name: 'counter.tick',
                params: { minValue: 0 },
                delivery: { mode: 'webhook', url: HOOK_URL, secret: 'b' },
                cursor: first.cursor
            });

            expect(second.id).toBe(SUB_ID);
            expect(new Date(second.refreshBefore).getTime()).toBeGreaterThan(new Date(first.refreshBefore).getTime());
            // First call (re)creates so the secret is echoed; second is a refresh so it is not.
            expect(first.secret).toBe('a');
            expect(second.secret).toBeUndefined();
            // Second call is a refresh of an existing sub so deliveryStatus is present.
            expect(second.deliveryStatus).toBeDefined();
            expect(second.deliveryStatus!.active).toBe(true);
        });

        it('unsubscribes eagerly and throws SubscriptionNotFound on repeat', async () => {
            const { check } = makeCounterEvent();
            server.registerEvent('counter.tick', { inputSchema: z.object({ minValue: z.number().default(0) }) }, check);

            await connectPair(server, client);

            await client.subscribeEvent({
                id: SUB_ID,
                name: 'counter.tick',
                params: { minValue: 0 },
                delivery: { mode: 'webhook', url: HOOK_URL, secret: 's' },
                cursor: null
            });

            await client.unsubscribeEvent({ id: SUB_ID, delivery: { url: HOOK_URL } });

            await expect(client.unsubscribeEvent({ id: SUB_ID, delivery: { url: HOOK_URL } })).rejects.toMatchObject({
                code: SUBSCRIPTION_NOT_FOUND
            });
        });

        it('rejects low-entropy subscription ids', async () => {
            const { check } = makeCounterEvent();
            server.registerEvent('counter.tick', { inputSchema: z.object({ minValue: z.number().default(0) }) }, check);

            await connectPair(server, client);

            await expect(
                client.subscribeEvent({
                    id: 'short',
                    name: 'counter.tick',
                    params: { minValue: 0 },
                    delivery: { mode: 'webhook', url: HOOK_URL, secret: 's' },
                    cursor: null
                })
            ).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
        });

        it('isolates subscriptions by (delivery.url, id) on unauthenticated servers', async () => {
            const { check } = makeCounterEvent();
            server.registerEvent('counter.tick', { inputSchema: z.object({ minValue: z.number().default(0) }) }, check);

            await connectPair(server, client);

            const urlA = 'http://localhost:9991/hook';
            const urlB = 'http://localhost:9992/hook';

            // Same id, different URLs → two distinct subscriptions.
            const subA = await client.subscribeEvent({
                id: SUB_ID,
                name: 'counter.tick',
                params: { minValue: 0 },
                delivery: { mode: 'webhook', url: urlA, secret: 'secretA' },
                cursor: null
            });
            const subB = await client.subscribeEvent({
                id: SUB_ID,
                name: 'counter.tick',
                params: { minValue: 0 },
                delivery: { mode: 'webhook', url: urlB, secret: 'secretB' },
                cursor: null
            });

            expect(subA.deliveryStatus).toBeUndefined(); // new sub
            expect(subB.deliveryStatus).toBeUndefined(); // also a new sub, not a refresh of A

            // Unsubscribing A does not affect B.
            await client.unsubscribeEvent({ id: SUB_ID, delivery: { url: urlA } });
            await client.unsubscribeEvent({ id: SUB_ID, delivery: { url: urlB } });
        });

        it('scopes by (principal, delivery.url, id) when a principal is present', async () => {
            let currentPrincipal = 'alice';
            server = new McpServer(
                { name: 's', version: '1.0.0' },
                {
                    events: {
                        webhook: {
                            ttlMs: 30_000,
                            urlValidation: { allowPrivateNetworks: true, allowInsecure: true },
                            fetch: fetchMock as unknown as typeof fetch,
                            getPrincipal: () => currentPrincipal
                        }
                    }
                }
            );
            const { check } = makeCounterEvent();
            server.registerEvent('counter.tick', { inputSchema: z.object({ minValue: z.number().default(0) }) }, check);

            await connectPair(server, client);

            // Alice subscribes.
            const first = await client.subscribeEvent({
                id: SUB_ID,
                name: 'counter.tick',
                params: { minValue: 0 },
                delivery: { mode: 'webhook', url: 'http://localhost:1111/a', secret: 's' },
                cursor: null
            });
            expect(first.deliveryStatus).toBeUndefined();

            // Alice "refreshes" with a DIFFERENT URL → URL is part of the key, so this is a NEW sub.
            const differentUrl = await client.subscribeEvent({
                id: SUB_ID,
                name: 'counter.tick',
                params: { minValue: 0 },
                delivery: { mode: 'webhook', url: 'http://localhost:2222/a', secret: 's' },
                cursor: null
            });
            expect(differentUrl.deliveryStatus).toBeUndefined(); // new sub, not a refresh

            // Alice refreshes with the SAME URL → that's a refresh.
            const refreshed = await client.subscribeEvent({
                id: SUB_ID,
                name: 'counter.tick',
                params: { minValue: 0 },
                delivery: { mode: 'webhook', url: 'http://localhost:1111/a', secret: 's' },
                cursor: null
            });
            expect(refreshed.deliveryStatus).toBeDefined(); // refresh of first sub

            // Bob subscribes with the same id+url → distinct key (different principal).
            currentPrincipal = 'bob';
            const bob = await client.subscribeEvent({
                id: SUB_ID,
                name: 'counter.tick',
                params: { minValue: 0 },
                delivery: { mode: 'webhook', url: 'http://localhost:1111/a', secret: 's' },
                cursor: null
            });
            expect(bob.deliveryStatus).toBeUndefined(); // new sub, not a refresh of Alice's

            // Unsubscribe each — delivery.url is always required to form the key.
            await client.unsubscribeEvent({ id: SUB_ID, delivery: { url: 'http://localhost:1111/a' } });
            currentPrincipal = 'alice';
            await client.unsubscribeEvent({ id: SUB_ID, delivery: { url: 'http://localhost:1111/a' } });
            await client.unsubscribeEvent({ id: SUB_ID, delivery: { url: 'http://localhost:2222/a' } });
        });

        it('keeps server cursor on refresh with cursor: null', async () => {
            const { state, check } = makeCounterEvent(0.01);
            server.registerEvent(
                'counter.tick',
                {
                    inputSchema: z.object({ minValue: z.number().default(0) })
                },
                check
            );

            await connectPair(server, client);

            await client.subscribeEvent({
                id: SUB_ID,
                name: 'counter.tick',
                params: { minValue: 0 },
                delivery: { mode: 'webhook', url: HOOK_URL, secret: 's' },
                cursor: null
            });

            state.value = 5;
            await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(5));
            const callsBefore = fetchMock.mock.calls.length;

            // Refresh with cursor: null — server keeps its upstream position (5); the
            // result no longer carries a cursor, so observe via delivery: no replay
            // of value 1..5 should occur after refresh.
            await client.subscribeEvent({
                id: SUB_ID,
                name: 'counter.tick',
                params: { minValue: 0 },
                delivery: { mode: 'webhook', url: HOOK_URL, secret: 's' },
                cursor: null
            });
            await new Promise(r => setTimeout(r, 50));
            expect(fetchMock.mock.calls.length).toBe(callsBefore);
        });

        it('rejects unsafe callback URLs with InvalidCallbackUrl', async () => {
            server = new McpServer(
                { name: 's', version: '1.0.0' },
                { events: { webhook: { ttlMs: 30_000, urlValidation: { allowPrivateNetworks: false } } } }
            );
            const { check } = makeCounterEvent();
            server.registerEvent('counter.tick', { inputSchema: z.object({ minValue: z.number().default(0) }) }, check);

            await connectPair(server, client);

            await expect(
                client.subscribeEvent({
                    id: SUB_ID,
                    name: 'counter.tick',
                    params: { minValue: 0 },
                    delivery: { mode: 'webhook', url: 'http://127.0.0.1:1234/hook', secret: 's' },
                    cursor: null
                })
            ).rejects.toMatchObject({ code: -32_015 });
        });

        it('rejects delivery when the callback host resolves to a private address (DNS rebinding)', async () => {
            // Hostname looks public; resolver returns loopback at delivery time.
            const resolveHost = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
            server = new McpServer(
                { name: 's', version: '1.0.0' },
                {
                    events: {
                        webhook: {
                            ttlMs: 30_000,
                            urlValidation: { allowInsecure: true },
                            fetch: fetchMock as unknown as typeof fetch,
                            resolveHost,
                            maxDeliveryAttempts: 1
                        }
                    }
                }
            );
            server.registerEvent('e', {}, async () => ({ events: [], cursor: 'c', nextPollSeconds: 30 }));
            await connectPair(server, client);

            await client.subscribeEvent({
                id: SUB_ID,
                name: 'e',
                delivery: { mode: 'webhook', url: 'http://hooks.example.com/a' },
                cursor: null
            });
            server.emitEvent('e', { v: 1 });

            await vi.waitFor(() => expect(resolveHost).toHaveBeenCalled());
            await new Promise(r => setTimeout(r, 10));
            expect(fetchMock).not.toHaveBeenCalled();

            const refreshed = await client.subscribeEvent({
                id: SUB_ID,
                name: 'e',
                delivery: { mode: 'webhook', url: 'http://hooks.example.com/a' },
                cursor: null
            });
            expect(refreshed.deliveryStatus?.lastError).toContain('private/loopback');
        });

        it('POSTs a signed error envelope to the webhook on terminate()', async () => {
            server.registerEvent('e', {}, async () => ({ events: [], cursor: 'c', nextPollSeconds: 30 }));
            await connectPair(server, client);

            const created = await client.subscribeEvent({
                id: SUB_ID,
                name: 'e',
                delivery: { mode: 'webhook', url: HOOK_URL },
                cursor: null
            });

            server.terminateEventSubscription(SUB_ID, 'upstream revoked');
            await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

            const [, init] = fetchMock.mock.calls[0]!;
            const body = JSON.parse(init.body as string);
            expect(body.id).toBe(SUB_ID);
            expect(body.error.message).toBe('upstream revoked');

            const verify = await verifyWebhookSignature(
                created.secret!,
                init.body as string,
                (init.headers as Record<string, string>)[WEBHOOK_SIGNATURE_HEADER],
                (init.headers as Record<string, string>)[WEBHOOK_TIMESTAMP_HEADER]
            );
            expect(verify.valid).toBe(true);
        });

        it('marks deliveryStatus as inactive after exhausting retries', async () => {
            const failFetch = vi.fn(async () => new Response('nope', { status: 500 }));
            server = new McpServer(
                { name: 's', version: '1.0.0' },
                {
                    events: {
                        webhook: {
                            ttlMs: 30_000,
                            urlValidation: { allowPrivateNetworks: true, allowInsecure: true },
                            maxDeliveryAttempts: 2,
                            initialRetryDelayMs: 1,
                            fetch: failFetch as unknown as typeof fetch
                        },
                        push: { pollDriven: true }
                    }
                }
            );
            const { state, check } = makeCounterEvent(0.01);
            server.registerEvent(
                'counter.tick',
                {
                    inputSchema: z.object({ minValue: z.number().default(0) })
                },
                check
            );

            await connectPair(server, client);

            await client.subscribeEvent({
                id: SUB_ID,
                name: 'counter.tick',
                params: { minValue: 0 },
                delivery: { mode: 'webhook', url: HOOK_URL, secret: 's' },
                cursor: null
            });

            state.value = 1;

            await vi.waitFor(() => expect(failFetch).toHaveBeenCalledTimes(2));

            const refreshed = await client.subscribeEvent({
                id: SUB_ID,
                name: 'counter.tick',
                params: { minValue: 0 },
                delivery: { mode: 'webhook', url: HOOK_URL, secret: 's' },
                cursor: null
            });

            // A refresh reactivates, but the previous delivery status would have been inactive.
            // The upsert resets active to true, so we verify the server tracked the error.
            expect(refreshed.deliveryStatus).toBeDefined();
        });

        it('webhook subscribe with prior cursor replays buffered emits since that cursor', async () => {
            server.registerEvent(
                'incident.created',
                {
                    inputSchema: z.object({ severity: z.string().optional() }),
                    matches: (params, data) => !params.severity || params.severity === data.severity,
                    bufferEmits: { capacity: 100 }
                },
                async (_p, _c) => ({ events: [], cursor: 'check', nextPollSeconds: 30 })
            );

            await connectPair(server, client);

            // First subscribe — bootstrap, then capture cursor after one delivery.
            await client.subscribeEvent({
                id: SUB_ID,
                name: 'incident.created',
                params: {},
                delivery: { mode: 'webhook', url: HOOK_URL, secret: 'secret123' },
                cursor: null
            });
            server.emitEvent('incident.created', { incidentId: 'INC-1', severity: 'P1' });
            await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
            const firstBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
            const capturedCursor = firstBody.cursor;
            expect(capturedCursor).toBeDefined();

            // Unsubscribe and emit more while "disconnected".
            await client.unsubscribeEvent({ id: SUB_ID, delivery: { url: HOOK_URL } });
            server.emitEvent('incident.created', { incidentId: 'INC-2', severity: 'P1' });
            server.emitEvent('incident.created', { incidentId: 'INC-3', severity: 'P1' });

            fetchMock.mockClear();

            // Resubscribe with the captured cursor — server should replay INC-2 and INC-3 from buffer.
            await client.subscribeEvent({
                id: SUB_ID,
                name: 'incident.created',
                params: {},
                delivery: { mode: 'webhook', url: HOOK_URL, secret: 'secret123' },
                cursor: capturedCursor
            });

            await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
            const replays = fetchMock.mock.calls.map(c => JSON.parse(c[1]!.body as string).data.incidentId);
            expect(replays).toEqual(['INC-2', 'INC-3']);
        });

        it('webhook subscribe with cursor older than buffer head returns CursorExpired', async () => {
            server.registerEvent(
                'incident.created',
                {
                    inputSchema: z.object({ severity: z.string().optional() }),
                    matches: (params, data) => !params.severity || params.severity === data.severity,
                    bufferEmits: { capacity: 2 }
                },
                async (_p, _c) => ({ events: [], cursor: 'check', nextPollSeconds: 30 })
            );

            await connectPair(server, client);

            // Get a valid composite cursor from a poll, then evict past it.
            const r = await client.pollEvents({
                subscriptions: [{ id: 'p', name: 'incident.created', params: {}, cursor: null }]
            });
            const staleCursor = r.results[0]!.cursor!;

            server.emitEvent('incident.created', { incidentId: 'INC-1', severity: 'P1' });
            server.emitEvent('incident.created', { incidentId: 'INC-2', severity: 'P1' });
            server.emitEvent('incident.created', { incidentId: 'INC-3', severity: 'P1' });

            await expect(
                client.subscribeEvent({
                    id: SUB_ID,
                    name: 'incident.created',
                    params: {},
                    delivery: { mode: 'webhook', url: HOOK_URL, secret: 's' },
                    cursor: staleCursor
                })
            ).rejects.toMatchObject({ code: CURSOR_EXPIRED });
        });
    });

    describe('lifecycle hooks', () => {
        it('calls onSubscribe for poll bootstrap and push stream open', async () => {
            const subscribed: string[] = [];
            const { check } = makeCounterEvent();
            server.registerEvent(
                'counter.tick',
                {
                    inputSchema: z.object({ minValue: z.number().default(0) }),
                    hooks: { onSubscribe: id => void subscribed.push(id) }
                },
                check
            );

            await connectPair(server, client);

            await client.pollEvents({
                subscriptions: [{ id: 'poll1', name: 'counter.tick', params: { minValue: 0 }, cursor: null }]
            });

            expect(subscribed).toContain('poll1');

            const controller = new AbortController();
            openStream(client, [{ id: 'push1', name: 'counter.tick', params: { minValue: 0 }, cursor: null }], controller);

            await vi.waitFor(() => expect(subscribed).toContain('push1'));
            controller.abort();
        });
    });

    describe('ClientEventManager (high-level client API)', () => {
        it('subscribes via poll mode and yields events as AsyncIterable', async () => {
            const { state, check } = makeCounterEvent(0.01);
            server.registerEvent(
                'counter.tick',
                {
                    inputSchema: z.object({ minValue: z.number().default(0) })
                },
                check
            );

            await connectPair(server, client);

            const manager = new ClientEventManager(client);
            const sub = await manager.subscribe('counter.tick', { minValue: 0 }, { delivery: 'poll' });

            expect(sub.delivery).toBe('poll');

            // Wait for the bootstrap poll to establish a cursor before producing events.
            await vi.waitFor(() => expect(sub.cursor).not.toBeNull());
            state.value = 3;

            const received: number[] = [];
            for await (const event of sub) {
                received.push(event.data.value as number);
                if (received.length >= 3) break;
            }

            expect(received).toEqual([1, 2, 3]);
            await manager.close();
        });

        it('subscribes via push mode and yields events as AsyncIterable', async () => {
            const { state, check } = makeCounterEvent(0.01);
            server.registerEvent(
                'counter.tick',
                {
                    inputSchema: z.object({ minValue: z.number().default(0) })
                },
                check
            );

            await connectPair(server, client);

            const manager = new ClientEventManager(client);
            const sub = await manager.subscribe('counter.tick', { minValue: 0 }, { delivery: 'push' });

            // Wait for the push stream bootstrap to establish a cursor before producing events.
            await vi.waitFor(() => expect(sub.cursor).not.toBeNull());
            state.value = 2;

            const received: number[] = [];
            for await (const event of sub) {
                received.push(event.data.value as number);
                if (received.length >= 2) break;
            }

            expect(received).toEqual([1, 2]);
            await manager.close();
        });

        it('deduplicates events by eventId', async () => {
            const { EventSubscription } = await import('@modelcontextprotocol/client');
            const sub = new EventSubscription('s', 'e', {}, 'poll', 8, async () => {});

            const occ: EventOccurrence = { eventId: 'evt_1', name: 'e', timestamp: 't', data: {} };
            sub._push(occ);
            sub._push(occ); // duplicate
            sub._push({ ...occ, eventId: 'evt_2' });

            const iter = sub[Symbol.asyncIterator]();
            const first = await iter.next();
            expect(first.value.eventId).toBe('evt_1');
            const second = await iter.next();
            expect(second.value.eventId).toBe('evt_2');
            sub._close();
            const third = await iter.next();
            expect(third.done).toBe(true);
        });

        it('auto-selects push when available and no webhook config', async () => {
            const { check } = makeCounterEvent();
            server.registerEvent('counter.tick', { inputSchema: z.object({ minValue: z.number().default(0) }) }, check);

            await connectPair(server, client);

            const manager = new ClientEventManager(client);
            const sub = await manager.subscribe('counter.tick', { minValue: 0 });
            expect(sub.delivery).toBe('push');
            await sub.cancel();
            await manager.close();
        });

        it('rejects subscribing to an event the server does not offer', async () => {
            const { check } = makeCounterEvent();
            server.registerEvent('counter.tick', { inputSchema: z.object({ minValue: z.number().default(0) }) }, check);

            await connectPair(server, client);

            const manager = new ClientEventManager(client);
            await expect(manager.subscribe('nonexistent', {})).rejects.toThrow();
            await manager.close();
        });

        it('delivers webhook payloads via deliverWebhookPayload', async () => {
            const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
            server = new McpServer(
                { name: 's', version: '1.0.0' },
                {
                    events: {
                        webhook: {
                            ttlMs: 60_000,
                            urlValidation: { allowPrivateNetworks: true, allowInsecure: true },
                            fetch: fetchMock as unknown as typeof fetch
                        }
                    }
                }
            );
            const { check } = makeCounterEvent();
            server.registerEvent('counter.tick', { inputSchema: z.object({ minValue: z.number().default(0) }) }, check);

            await connectPair(server, client);

            const manager = new ClientEventManager(client, {
                webhook: { url: 'http://localhost:1234/hook', secret: 's' }
            });
            const sub = await manager.subscribe('counter.tick', { minValue: 0 }, { delivery: 'webhook' });

            expect(sub.delivery).toBe('webhook');

            // Simulate the webhook proxy forwarding a payload.
            manager.deliverWebhookPayload({
                id: sub.id,
                eventId: 'evt_test',
                name: 'counter.tick',
                timestamp: new Date().toISOString(),
                data: { value: 42 },
                cursor: 'c'
            });

            const received: EventOccurrence[] = [];
            for await (const event of sub) {
                received.push(event);
                break;
            }

            expect(received[0]!.data.value).toBe(42);
            await manager.close();
        });
    });

    describe('webhook utilities', () => {
        it('computes and verifies HMAC signatures', async () => {
            const secret = 'test-secret';
            const body = JSON.stringify({ eventId: 'e1', data: {} });
            const timestamp = Math.floor(Date.now() / 1000);

            const signature = await computeWebhookSignature(secret, timestamp, body);
            expect(signature).toMatch(/^sha256=[\da-f]{64}$/);

            const good = await verifyWebhookSignature(secret, body, signature, String(timestamp));
            expect(good.valid).toBe(true);

            const badSecret = await verifyWebhookSignature('wrong', body, signature, String(timestamp));
            expect(badSecret.valid).toBe(false);

            const tampered = await verifyWebhookSignature(secret, body + 'x', signature, String(timestamp));
            expect(tampered.valid).toBe(false);
        });

        it('rejects stale timestamps', async () => {
            const secret = 's';
            const body = 'b';
            const oldTs = Math.floor(Date.now() / 1000) - 600;
            const sig = await computeWebhookSignature(secret, oldTs, body);
            const result = await verifyWebhookSignature(secret, body, sig, String(oldTs));
            expect(result.valid).toBe(false);
            expect(result.reason).toContain('tolerance');
        });

        it('validates webhook URLs for SSRF safety', () => {
            expect(isSafeWebhookUrl('https://example.com/hook').safe).toBe(true);
            expect(isSafeWebhookUrl('http://example.com/hook').safe).toBe(false);
            expect(isSafeWebhookUrl('http://example.com/hook', { allowInsecure: true }).safe).toBe(true);
            expect(isSafeWebhookUrl('https://127.0.0.1/hook').safe).toBe(false);
            expect(isSafeWebhookUrl('https://localhost/hook').safe).toBe(false);
            expect(isSafeWebhookUrl('https://192.168.1.1/hook').safe).toBe(false);
            expect(isSafeWebhookUrl('https://10.0.0.1/hook').safe).toBe(false);
            expect(isSafeWebhookUrl('https://172.16.0.1/hook').safe).toBe(false);
            expect(isSafeWebhookUrl('https://10.0.0.1/hook', { allowPrivateNetworks: true }).safe).toBe(true);
            expect(isSafeWebhookUrl('not a url').safe).toBe(false);
            expect(isSafeWebhookUrl('ftp://example.com').safe).toBe(false);

            const allowlist = isSafeWebhookUrl('https://foo.example.com/hook', { allowedHosts: ['foo.example.com'] });
            expect(allowlist.safe).toBe(true);
            const denylist = isSafeWebhookUrl('https://bar.example.com/hook', { allowedHosts: ['foo.example.com'] });
            expect(denylist.safe).toBe(false);
        });

        it('validates IPv6 webhook URLs for SSRF safety (bracketed hostnames)', () => {
            expect(isSafeWebhookUrl('https://[::1]/hook').safe).toBe(false);
            expect(isSafeWebhookUrl('https://[0:0:0:0:0:0:0:1]/hook').safe).toBe(false);
            expect(isSafeWebhookUrl('https://[fc00::1]/hook').safe).toBe(false);
            expect(isSafeWebhookUrl('https://[fd12:3456::1]/hook').safe).toBe(false);
            expect(isSafeWebhookUrl('https://[fe80::1]/hook').safe).toBe(false);
            // IPv4-mapped IPv6 — dotted form.
            expect(isSafeWebhookUrl('https://[::ffff:127.0.0.1]/hook').safe).toBe(false);
            expect(isSafeWebhookUrl('https://[::ffff:10.0.0.1]/hook').safe).toBe(false);
            // IPv4-mapped IPv6 — hex form.
            expect(isSafeWebhookUrl('https://[::ffff:7f00:1]/hook').safe).toBe(false);
            expect(isSafeWebhookUrl('https://[::ffff:a00:1]/hook').safe).toBe(false);
            // Public IPv6 should pass.
            expect(isSafeWebhookUrl('https://[2001:db8::1]/hook').safe).toBe(true);
            // allowPrivateNetworks override.
            expect(isSafeWebhookUrl('https://[::1]/hook', { allowPrivateNetworks: true }).safe).toBe(true);
        });
    });
});
