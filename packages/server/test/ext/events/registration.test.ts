import type { DiscoverResult, InitializeResult } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport } from '@modelcontextprotocol/core-internal';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import * as z from 'zod/v4';

import type { SubscriptionSource } from '../../../src/ext/events/extension';
import type { EventInput, ListEventsResult } from '../../../src/ext/events/index';
import { EventsError, EventsExtension } from '../../../src/ext/events/index';
import type { EventsTestHook } from '../../../src/ext/events/testHook';
import { McpServer } from '../../../src/server/mcp';
import { legacyAdvertisedCapabilities } from '../../../src/server/modernOnlyExtensions';
import { errorOf, LEGACY, resultOf, serve } from './harness';

const P = z.object({ n: z.number() });
const tick = () => ({ events: [], cursor: '0' });
const webhookSender = async () => ({ status: 200, body: '' });

function testHook(events: EventsExtension): EventsTestHook {
    return (events as unknown as Record<symbol, EventsTestHook>)[Symbol.for('mcp.events.testHook')]!;
}

async function listOf(events: EventsExtension): Promise<ListEventsResult> {
    return resultOf(await serve(events).rpc('events/list')) as ListEventsResult;
}

describe('discovery', () => {
    it('declares {} on server/discover and nothing on legacy initialize', async () => {
        const events = new EventsExtension();
        events.registerEvent('tick', { payloadSchema: P, check: tick });
        const { rpc } = serve(events);
        const discover = resultOf(await rpc('server/discover')) as DiscoverResult;
        expect(discover.capabilities.extensions?.['io.modelcontextprotocol/events']).toEqual({});
        const init = resultOf(
            await rpc(
                'initialize',
                { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 't', version: '1' } },
                { era: 'legacy' }
            )
        ) as InitializeResult;
        expect(init.capabilities.extensions?.['io.modelcontextprotocol/events']).toBeUndefined();
    });

    it('hides only the modern-only extensions from the legacy capabilities', () => {
        const mcp = new McpServer({ name: 't', version: '1' }, { capabilities: { extensions: { 'example.com/other': {} } } });
        new EventsExtension().attach(mcp);
        expect(legacyAdvertisedCapabilities(mcp.server, mcp.server.getCapabilities()).extensions).toEqual({ 'example.com/other': {} });
        const alone = new McpServer({ name: 't', version: '1' });
        new EventsExtension().attach(alone);
        expect(legacyAdvertisedCapabilities(alone.server, alone.server.getCapabilities())).not.toHaveProperty('extensions');
    });

    it('answers -32601 to a legacy events request', async () => {
        const events = new EventsExtension();
        events.registerEvent('tick', { payloadSchema: P, check: tick });
        const reply = await serve(events).rpc('events/list', {}, { era: 'legacy' });
        expect(errorOf(reply)).toMatchObject({ code: -32_601, message: 'Method not found' });
    });

    it('lists descriptors with JSON schemas and computed delivery', async () => {
        const plain = new EventsExtension();
        plain.registerEvent('tick', {
            description: 'Ticks',
            inputSchema: z.object({ every: z.number().optional() }),
            payloadSchema: P,
            _meta: { 'example.com/key': 1 },
            check: tick
        });
        plain.registerEvent('quiet', { emitOnly: true, payloadSchema: P, delivery: { push: false } });
        const list = await listOf(plain);
        expect(list).toMatchObject({ resultType: 'complete' });
        expect(list.nextCursor).toBeUndefined();
        expect(list.events).toMatchObject([
            {
                name: 'tick',
                description: 'Ticks',
                delivery: ['poll', 'push'],
                inputSchema: { type: 'object', properties: { every: { type: 'number' } } },
                payloadSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
                _meta: { 'example.com/key': 1 }
            },
            { name: 'quiet', delivery: ['poll'], inputSchema: { type: 'object' } }
        ]);
        expect(list.events[1]).not.toHaveProperty('description');

        const webhook = new EventsExtension({ webhookTtlMs: 60_000, webhookSender, getPrincipal: () => 'alice' });
        webhook.registerEvent('tick', { payloadSchema: P, check: tick });
        webhook.registerEvent('hooked', { payloadSchema: P, check: tick, delivery: { poll: false, push: false } });
        expect((await listOf(webhook)).events.map(event => event.delivery)).toEqual([['poll', 'push', 'webhook'], ['webhook']]);
    });

    it('reports an invalid x-mcp-header to onerror and still lists the event', async () => {
        const onerror = vi.fn();
        const events = new EventsExtension({ onerror });
        events.registerEvent('r', {
            inputSchema: z.object({ r: z.object({}).meta({ 'x-mcp-header': 'R' }) }),
            payloadSchema: P,
            check: tick
        });
        expect(onerror).toHaveBeenCalledOnce();
        expect(onerror.mock.calls[0]![0]).toBeInstanceOf(Error);
        expect(onerror.mock.calls[0]![0].message).toMatch(
            /^event 'r' carries an invalid x-mcp-header declaration and will be excluded by conforming Streamable HTTP clients: /
        );
        const [listed] = (await listOf(events)).events;
        expect(listed).toMatchObject({ name: 'r', inputSchema: { properties: { r: { 'x-mcp-header': 'R' } } } });
    });
});

describe('options', () => {
    it('refuses partial webhook configuration', () => {
        expect(() => new EventsExtension({ webhookTtlMs: 60_000 })).toThrow(TypeError);
        expect(() => new EventsExtension({ webhookSender })).toThrow(TypeError);
        expect(() => new EventsExtension({ webhookTtlMs: 60_000, webhookSender })).toThrow(TypeError);
        expect(() => new EventsExtension({ getPrincipal: () => 'alice' })).not.toThrow();
        expect(() => new EventsExtension({ webhookTtlMs: 60_000, webhookSender, getPrincipal: () => 'alice' })).not.toThrow();
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s for a numeric option', value => {
        expect(() => new EventsExtension({ heartbeatMs: value })).toThrow(TypeError);
        expect(() => new EventsExtension({ maxSubscriptions: value })).toThrow(TypeError);
        expect(() => new EventsExtension({ emitBuffer: { maxEvents: value } })).toThrow(TypeError);
        expect(() => new EventsExtension({ webhookTtlMs: value, webhookSender, getPrincipal: () => 'alice' })).toThrow(TypeError);
    });

    it.each([1.5, 0.5])('refuses %s for a count option', value => {
        expect(() => new EventsExtension({ maxSubscriptions: value })).toThrow(/maxSubscriptions must be a positive integer/);
        expect(() => new EventsExtension({ emitBuffer: { maxEvents: value } })).toThrow(TypeError);
        expect(() => new EventsExtension({ heartbeatMs: value })).not.toThrow();
    });

    it('serves at most 1024 subscriptions by default', async () => {
        const events = new EventsExtension();
        events.registerEvent('tick', { payloadSchema: P, check: tick });
        const { rpc } = serve(events);
        for (let n = 0; n < 1024; n++) resultOf(await rpc('events/poll', { name: 'tick', arguments: { n } }));
        expect(errorOf(await rpc('events/poll', { name: 'tick', arguments: { n: 1024 } }))).toMatchObject({
            code: -32_025,
            data: { limit: 'subscriptions', max: 1024 }
        });
        resultOf(await rpc('events/poll', { name: 'tick', arguments: { n: 0 } }));
    });

    it('accepts only exact origins as trustedOrigins', () => {
        expect(() => new EventsExtension({ trustedOrigins: ['http://127.0.0.1:9000', 'https://example.com'] })).not.toThrow();
        for (const origin of ['http://127.0.0.1:9000/', 'https://example.com/hook', 'HTTPS://EXAMPLE.COM', 'example.com', 'not a url']) {
            expect(() => new EventsExtension({ trustedOrigins: [origin] })).toThrow(TypeError);
        }
    });
});

describe('registerEvent', () => {
    it('enforces the two kinds at runtime', () => {
        const events = new EventsExtension();
        const message = /pass check\(\), or emitOnly: true and call emit\(\) on the returned handle/;
        // @ts-expect-error check with emitOnly
        expect(() => events.registerEvent('a', { emitOnly: true, payloadSchema: P, check: tick })).toThrow(/emitOnly: true/);
        // @ts-expect-error neither check nor emitOnly
        expect(() => events.registerEvent('b', { payloadSchema: P })).toThrow(TypeError);
        // @ts-expect-error match without emitOnly
        expect(() => events.registerEvent('c', { payloadSchema: P, check: tick, match: () => true })).toThrow(message);
        // @ts-expect-error transform without emitOnly
        expect(() => events.registerEvent('d', { payloadSchema: P, check: tick, transform: (_ctx, event) => event })).toThrow(message);
        const noMode = { payloadSchema: P, check: tick, delivery: { poll: false, push: false } } as const;
        expect(() => events.registerEvent('e', noMode)).toThrow(/delivery turns off every mode/);
    });

    it('types emit() only on emit-only handles', () => {
        const events = new EventsExtension();
        const checkHandle = events.registerEvent('a', { payloadSchema: P, check: () => ({ events: [], cursor: null }) });
        // @ts-expect-error no emit on a check type
        void checkHandle.emit;
        expectTypeOf(events.registerEvent('b', { emitOnly: true, payloadSchema: z.object({ n: z.number() }) }).emit)
            .parameter(0)
            .toEqualTypeOf<EventInput<{ n: number }>>();
        expectTypeOf(checkHandle.update).toBeCallableWith({ description: 'v2' });
    });

    it('refuses the same schemas again and terminates live subscriptions when a schema changes', async () => {
        const events = new EventsExtension();
        const terminate = vi.fn<SubscriptionSource['terminate']>(async () => {});
        testHook(events).addSource({ terminate });
        events.registerEvent('tick', { payloadSchema: P, check: tick });
        expect(() => events.registerEvent('tick', { emitOnly: true, payloadSchema: P })).toThrow(/already registered/);
        expect(terminate).not.toHaveBeenCalled();

        events.registerEvent('tick', { payloadSchema: z.object({ n: z.string() }), check: tick });
        expect(terminate).toHaveBeenLastCalledWith('tick', expect.any(EventsError), undefined);
        expect(terminate.mock.lastCall![1]).toMatchObject({
            kind: 'unsupported',
            data: { feature: 'payloadSchema', reason: 'schema_changed' }
        });

        events.registerEvent('tick', { inputSchema: z.object({ q: z.string() }), payloadSchema: z.object({ n: z.string() }), check: tick });
        expect(terminate.mock.lastCall![1]).toMatchObject({
            kind: 'unsupported',
            data: { feature: 'inputSchema', reason: 'schema_changed' }
        });
        expect((await listOf(events)).events).toMatchObject([
            {
                name: 'tick',
                inputSchema: { properties: { q: { type: 'string' } } },
                payloadSchema: { properties: { n: { type: 'string' } } }
            }
        ]);
    });

    it('update() changes the description; remove() drops the event', async () => {
        const events = new EventsExtension();
        const terminate = vi.fn<SubscriptionSource['terminate']>(async () => {});
        testHook(events).addSource({ terminate });
        const handle = events.registerEvent('tick', { description: 'v1', payloadSchema: P, check: tick });
        events.registerEvent('other', { payloadSchema: P, check: tick });
        expect(handle.name).toBe('tick');

        handle.update({ description: 'v2', inputSchema: z.object({ q: z.string().optional() }) });
        expect((await listOf(events)).events).toMatchObject([
            { name: 'tick', description: 'v2', inputSchema: { properties: { q: { type: 'string' } } } },
            { name: 'other' }
        ]);
        expect(terminate).not.toHaveBeenCalled();

        handle.remove();
        expect((await listOf(events)).events.map(event => event.name)).toEqual(['other']);
        expect(terminate).toHaveBeenCalledOnce();
        expect(terminate).toHaveBeenCalledWith('tick', expect.any(EventsError), undefined);
        expect(terminate.mock.lastCall![1]).toMatchObject({ kind: 'notFound', message: 'Event type removed', data: { kind: 'event' } });

        expect(() => handle.update({ description: 'v3' })).toThrow(/removed or replaced/);
        handle.remove();
        expect(terminate).toHaveBeenCalledOnce();
    });

    it('update() takes only the fields it lists, whatever else the object carries', async () => {
        const events = new EventsExtension();
        const handle = events.registerEvent('tick', { payloadSchema: P, check: tick });
        const changes = { description: 'v2', delivery: { poll: false }, emitOnly: true, check: undefined };
        handle.update(changes);
        expect((await listOf(events)).events).toMatchObject([{ name: 'tick', description: 'v2', delivery: ['poll', 'push'] }]);
        // Still a check type: the poll runs check(), whose cursor is '0'.
        expect(resultOf(await serve(events).rpc('events/poll', { name: 'tick', cursor: 'c' }))).toMatchObject({ cursor: '0' });
    });

    it('terminate() reaches every subscription source', async () => {
        const events = new EventsExtension();
        const first = vi.fn<SubscriptionSource['terminate']>(async () => {});
        const second = vi.fn<SubscriptionSource['terminate']>(async () => {});
        testHook(events).addSource({ terminate: first });
        testHook(events).addSource({ terminate: second });
        const handle = events.registerEvent('tick', { payloadSchema: P, check: tick });
        const revoked = new EventsError('forbidden', 'Access revoked');
        await expect(handle.terminate(revoked, { subscriptionId: 'sub-1' })).resolves.toBeUndefined();
        expect(first).toHaveBeenCalledWith('tick', revoked, 'sub-1');
        expect(second).toHaveBeenCalledWith('tick', revoked, 'sub-1');
        await handle.terminate(revoked);
        expect(first).toHaveBeenLastCalledWith('tick', revoked, undefined);
    });
});

describe('attach', () => {
    it('follows the Skills attach rules', async () => {
        const events = new EventsExtension();
        const mcp = new McpServer({ name: 't', version: '1' });
        events.attach(mcp);
        events.attach(mcp);
        expect(mcp.server.getCapabilities().extensions).toEqual({ 'io.modelcontextprotocol/events': {} });
        expect(() => new EventsExtension().attach(mcp)).toThrow(
            'another events extension is already attached to this server; attach one per server'
        );

        const connected = new McpServer({ name: 't', version: '1' });
        const [, serverSide] = InMemoryTransport.createLinkedPair();
        await connected.connect(serverSide);
        expect(() => events.attach(connected)).toThrow('attach events before connecting the server');
        await connected.close();

        const taken = new McpServer({ name: 't', version: '1' });
        taken.server.setRequestHandler('events/poll', { params: z.object({}) }, () => ({}));
        expect(() => events.attach(taken)).toThrow('A request handler for events/poll already exists, which would be overridden');
        expect(taken.server.getCapabilities().extensions).toBeUndefined();
        expect(() => taken.server.assertCanSetRequestHandler('events/list')).not.toThrow();
    });
});

describe('test hook', () => {
    it('is reachable by its symbol only, and restart() bumps the generation', () => {
        const events = new EventsExtension({ trustedOrigins: ['http://127.0.0.1:9000'] });
        const hook = testHook(events);
        expect(Object.getOwnPropertyDescriptor(events, Symbol.for('mcp.events.testHook'))).toMatchObject({ enumerable: false });
        expect(Object.getOwnPropertySymbols({ ...events })).toEqual([]);
        const generation = hook.generation();
        hook.restart();
        expect(hook.generation()).toBe(generation + 1);
    });

    it('adds trusted origins to the live set with the constructor validation', () => {
        const hook = testHook(new EventsExtension({ trustedOrigins: ['http://127.0.0.1:9000'] }));
        hook.addTrustedOrigin('http://localhost:8080');
        expect(hook.state().trustedOrigins).toEqual(['http://127.0.0.1:9000', 'http://localhost:8080']);
        expect(() => hook.addTrustedOrigin('http://localhost:8080/hook')).toThrow(TypeError);
    });
});
