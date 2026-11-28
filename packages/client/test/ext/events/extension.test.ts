import { EVENTS_EXTENSION_ID } from '@modelcontextprotocol/core/ext/events';
import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Client } from '../../../src/client/client';
import { selectDeliveryMode } from '../../../src/ext/events/extension';
import type { EventSubscription } from '../../../src/ext/events/index';
import { EventsClientExtension, EventsError, NoCompatibleDeliveryModeError } from '../../../src/ext/events/index';
import type { Handler } from './scripted';
import { callsTo, connectEvents, descriptor, LEGACY, listing, occurrence, quietPoll, RpcError, script } from './scripted';

const UNSUPPORTED = 'Server does not support the io.modelcontextprotocol/events extension (required for events/list)';

const subscriptions: EventSubscription[] = [];
afterEach(async () => {
    await Promise.all(subscriptions.splice(0).map(subscription => subscription.cancel()));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

async function track<T>(subscription: Promise<EventSubscription<T>>): Promise<EventSubscription<T>> {
    const resolved = await subscription;
    subscriptions.push(resolved as EventSubscription);
    return resolved;
}

describe('EventsClientExtension gating', () => {
    it('refuses calls when the server lacks the extension or the connection is legacy', async () => {
        for (const setup of [{ capabilities: {} }, { revision: LEGACY }] as const) {
            const { events, calls } = await connectEvents({ 'events/list': listing(descriptor('tick')) }, setup);
            expect(events.supported).toBe(false);
            await expect(events.list()).rejects.toMatchObject({ code: SdkErrorCode.CapabilityNotSupported, message: UNSUPPORTED });
            await expect(events.subscribe({ name: 'tick' })).rejects.toMatchObject({ code: SdkErrorCode.CapabilityNotSupported });
            expect(calls.filter(call => call.method.startsWith('events/'))).toEqual([]);
        }
        const { events } = await connectEvents({});
        expect(events.supported).toBe(true);
    });

    it('declares itself in the per-request client capabilities', async () => {
        const { events, calls } = await connectEvents({ 'events/list': listing() });
        await events.list();
        const meta = callsTo(calls, 'events/list')[0]!.params['_meta'] as Record<string, { extensions: Record<string, unknown> }>;
        expect(meta['io.modelcontextprotocol/clientCapabilities']!.extensions[EVENTS_EXTENSION_ID]).toEqual({});
    });

    it('serves one client, and refuses calls before a client is constructed with it', async () => {
        const events = new EventsClientExtension();
        await expect(events.list()).rejects.toThrow(
            "No client was constructed with this EventsClientExtension; pass it in the client's extensions option before events/list"
        );
        new Client({ name: 'a', version: '1.0.0' }, { extensions: [events] });
        expect(() => new Client({ name: 'b', version: '1.0.0' }, { extensions: [events] })).toThrow(
            "This EventsClientExtension is already in another client; pass a new one in each client's extensions option"
        );
    });

    it('rejects a pollIntervalFloorMs that is not a positive number', () => {
        for (const pollIntervalFloorMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => new EventsClientExtension({ pollIntervalFloorMs })).toThrow(TypeError);
        }
    });
});

describe('EventsClientExtension.list', () => {
    it('walks list pages and drops invalid x-mcp-header event types', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const bad = descriptor('bad', {
            inputSchema: { type: 'object', properties: { region: { type: 'number', 'x-mcp-header': 'Region' } } }
        });
        const pages: Handler = params =>
            params['cursor'] === 'p2' ? { events: [bad, descriptor('tock')] } : { events: [descriptor('tick')], nextCursor: 'p2' };
        const { events, calls } = await connectEvents({ 'events/list': pages });

        const all = await events.list();
        expect(all.events.map(event => event.name)).toEqual(['tick', 'tock']);
        expect(all).not.toHaveProperty('nextCursor');
        expect(callsTo(calls, 'events/list').map(call => call.params['cursor'])).toEqual([undefined, 'p2']);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("'bad'"));

        // With a cursor: that one page, its nextCursor kept, the invalid type dropped there too.
        expect(await events.list({ cursor: 'p1' })).toEqual({ events: [descriptor('tick')], nextCursor: 'p2' });
        expect(await events.list({ cursor: 'p2' })).toEqual({ events: [descriptor('tock')] });

        // The dropped type is not subscribable: it is not in the cache, and the refetch excludes it again.
        await expect(events.subscribe({ name: 'bad' })).rejects.toMatchObject({ kind: 'notFound' });
    });
});

describe('EventsClientExtension requests', () => {
    it('mirrors annotated arguments into Mcp-Param headers and retries once on -32020', async () => {
        const annotated = descriptor('tick', {
            inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' } } }
        });
        // The first listing predates the annotation, so the first poll goes out without the header.
        const lists = [descriptor('tick'), annotated];
        const { events, calls } = await connectEvents({
            'events/list': () => ({ events: [lists.length > 1 ? lists.shift()! : lists[0]!] }),
            'events/poll': (_params, call) => {
                if (call.headers['Mcp-Param-Region'] !== 'us-west1') throw new RpcError(-32_020, 'Mcp-Param-Region header mismatch');
                return { events: [occurrence('e1')], cursor: 'c1', nextPollMs: 60_000 };
            }
        });
        const sub = await track(events.subscribe({ name: 'tick', arguments: { region: 'us-west1' }, delivery: 'poll' }));
        const first = await sub[Symbol.asyncIterator]().next();

        expect(first.value).toMatchObject({ eventId: 'e1' });
        expect(callsTo(calls, 'events/list')).toHaveLength(2);
        expect(callsTo(calls, 'events/poll').map(call => call.headers['Mcp-Param-Region'])).toEqual([undefined, 'us-west1']);
        expect(calls.map(call => call.method)).toEqual(['events/list', 'events/poll', 'events/list', 'events/poll']);
    });

    it('rejects with the first -32020 in a browser, which sends no Mcp-Param headers, without listing the event types again', async () => {
        const annotated = descriptor('tick', {
            inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' } } }
        });
        const { events, calls } = await connectEvents({
            'events/list': listing(annotated),
            'events/poll': (_params, call) => {
                if (call.headers['Mcp-Param-Region'] !== 'us-west1') throw new RpcError(-32_020, 'Mcp-Param-Region header mismatch');
                return quietPoll(_params, call);
            }
        });
        vi.stubGlobal('window', {});
        vi.stubGlobal('document', {});

        const error = await events
            .subscribe({ name: 'tick', arguments: { region: 'us-west1' }, delivery: 'poll' })
            .catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(ProtocolError);
        expect(error).toMatchObject({ code: -32_020 });
        expect(calls.map(call => call.method)).toEqual(['events/list', 'events/poll']);
        expect(callsTo(calls, 'events/poll')[0]!.headers).toEqual({});
    });

    it('turns events error codes into EventsError', async () => {
        const { events } = await connectEvents({
            'events/list': listing(descriptor('tick')),
            'events/poll': script(new RpcError(-32_024, 'Forbidden', { reason: 'Access revoked' }))
        });
        const error = await events.subscribe({ name: 'tick', delivery: 'poll' }).catch((error_: unknown) => error_);
        expect(error).toBeInstanceOf(EventsError);
        expect(error).toMatchObject({ kind: 'forbidden', code: -32_024, data: { reason: 'Access revoked' } });

        const failing = await connectEvents({ 'events/list': script(new RpcError(-32_026, 'Unsupported'), new RpcError(-32_603, 'boom')) });
        const unsupported = await failing.events.list().catch((error_: unknown) => error_);
        expect(unsupported).toBeInstanceOf(EventsError);
        expect(unsupported).toMatchObject({ kind: 'unsupported' });
        const internal = await failing.events.list().catch((error_: unknown) => error_);
        expect(internal).toBeInstanceOf(ProtocolError);
        expect(internal).not.toBeInstanceOf(EventsError);
        expect(internal).toMatchObject({ code: -32_603, message: 'boom' });
    });
});

describe('EventsClientExtension.subscribe', () => {
    it('selects webhook, then push, then poll, and explains when nothing fits', async () => {
        const { events } = await connectEvents({
            'events/list': listing(descriptor('tick', { delivery: ['webhook', 'poll'] })),
            'events/poll': quietPoll
        });
        const sub = await track(events.subscribe({ name: 'tick' }));
        expect(sub.deliveryMode).toBe('poll');

        const error = await events.subscribe({ name: 'tick', delivery: 'push' }).catch((error_: unknown) => error_);
        expect(error).toBeInstanceOf(NoCompatibleDeliveryModeError);
        expect(error).toBeInstanceOf(SdkError);
        expect(error).toMatchObject({ eventName: 'tick', offered: ['webhook', 'poll'], usable: ['push'] });

        expect(selectDeliveryMode('tick', ['poll', 'push', 'webhook'], undefined, true)).toBe('webhook');
        expect(selectDeliveryMode('tick', ['poll', 'push', 'webhook'], undefined, false)).toBe('push');
        expect(selectDeliveryMode('tick', ['poll', 'push'], undefined, true)).toBe('push');
        expect(selectDeliveryMode('tick', ['poll', 'push', 'webhook'], 'poll', true)).toBe('poll');
        expect(() => selectDeliveryMode('tick', ['webhook'], undefined, false)).toThrow(
            expect.objectContaining({ offered: ['webhook'], usable: ['push', 'poll'] })
        );
        expect(() => selectDeliveryMode('tick', ['webhook', 'poll'], 'webhook', false)).toThrow(expect.objectContaining({ usable: [] }));
    });

    it('lists again once when the server refuses the delivery mode of a stale listing, and subscribes in the mode selected again', async () => {
        const stale = descriptor('tick', { delivery: ['push', 'poll'] });
        const refusePush: Handler = () => {
            throw new RpcError(-32_026, 'Unsupported', { feature: 'deliveryMode', value: 'push' });
        };
        const relisting = (fresh: ReturnType<typeof descriptor>) => {
            const listings = [[stale], [fresh]];
            return () => ({ events: listings.shift() ?? [fresh] });
        };

        const pollOnly = descriptor('tick', { delivery: ['poll'] });
        const moved = await connectEvents({ 'events/list': relisting(pollOnly), 'events/stream': refusePush, 'events/poll': quietPoll });
        await moved.events.list();
        const sub = await track(moved.events.subscribe({ name: 'tick' }));
        expect(sub.deliveryMode).toBe('poll');
        expect(callsTo(moved.calls, 'events/list')).toHaveLength(2);
        expect(callsTo(moved.calls, 'events/stream')).toHaveLength(1);

        // A forced mode is not changed to another one.
        const forced = await connectEvents({ 'events/list': relisting(pollOnly), 'events/stream': refusePush, 'events/poll': quietPoll });
        await forced.events.list();
        const error = await forced.events.subscribe({ name: 'tick', delivery: 'push' }).catch((error_: unknown) => error_);
        expect(error).toBeInstanceOf(NoCompatibleDeliveryModeError);
        expect(error).toMatchObject({ offered: ['poll'], usable: ['push'] });
        expect(callsTo(forced.calls, 'events/poll')).toHaveLength(0);

        // A fresh listing that still selects the refused mode rejects with the refusal.
        const same = await connectEvents({ 'events/list': relisting(stale), 'events/stream': refusePush, 'events/poll': quietPoll });
        await same.events.list();
        const refused = await same.events.subscribe({ name: 'tick' }).catch((error_: unknown) => error_);
        expect(refused).toBeInstanceOf(EventsError);
        expect(refused).toMatchObject({ kind: 'unsupported', data: { feature: 'deliveryMode', value: 'push' } });
        expect(callsTo(same.calls, 'events/list')).toHaveLength(2);
        expect(callsTo(same.calls, 'events/stream')).toHaveLength(1);
    });

    it('refetches events/list for an uncached name and refuses one the server does not list', async () => {
        const { events, calls } = await connectEvents({ 'events/list': listing(descriptor('tick')), 'events/poll': quietPoll });
        await track(events.subscribe({ name: 'tick' }));
        await track(events.subscribe({ name: 'tick' }));
        expect(callsTo(calls, 'events/list')).toHaveLength(1);

        const error = await events.subscribe({ name: 'missing' }).catch((error_: unknown) => error_);
        expect(error).toBeInstanceOf(EventsError);
        expect(error).toMatchObject({ kind: 'notFound', message: 'Event type not found', data: { kind: 'event' } });
        expect(callsTo(calls, 'events/list')).toHaveLength(2);
    });
});
