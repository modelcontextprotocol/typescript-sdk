import { describe, expect, it } from 'vitest';

import {
    InMemoryServerEventBus,
    createServerNotifier,
    honoredSubset,
    listenFilterAccepts,
    serverEventToNotification
} from '../../src/server/serverEventBus.js';

describe('listenFilterAccepts', () => {
    it('accepts only the change types the filter explicitly opted in to', () => {
        const filter = { toolsListChanged: true as const };
        expect(listenFilterAccepts(filter, { kind: 'tools_list_changed' })).toBe(true);
        expect(listenFilterAccepts(filter, { kind: 'prompts_list_changed' })).toBe(false);
        expect(listenFilterAccepts(filter, { kind: 'resources_list_changed' })).toBe(false);
        expect(listenFilterAccepts(filter, { kind: 'resource_updated', uri: 'file:///x' })).toBe(false);
    });

    it('treats false and absent identically (opt-in only on true)', () => {
        expect(listenFilterAccepts({ toolsListChanged: false }, { kind: 'tools_list_changed' })).toBe(false);
        expect(listenFilterAccepts({}, { kind: 'tools_list_changed' })).toBe(false);
    });

    it('matches resource_updated only on the exact opted-in URI', () => {
        const filter = { resourceSubscriptions: ['file:///project/config.json'] };
        expect(listenFilterAccepts(filter, { kind: 'resource_updated', uri: 'file:///project/config.json' })).toBe(true);
        expect(listenFilterAccepts(filter, { kind: 'resource_updated', uri: 'file:///other' })).toBe(false);
        // Empty list = no resource updates accepted.
        expect(listenFilterAccepts({ resourceSubscriptions: [] }, { kind: 'resource_updated', uri: 'file:///x' })).toBe(false);
        // Absent = no resource updates accepted.
        expect(listenFilterAccepts({}, { kind: 'resource_updated', uri: 'file:///x' })).toBe(false);
    });

    it('an empty filter accepts nothing (un-requested types are provably never delivered)', () => {
        const filter = {};
        expect(listenFilterAccepts(filter, { kind: 'tools_list_changed' })).toBe(false);
        expect(listenFilterAccepts(filter, { kind: 'prompts_list_changed' })).toBe(false);
        expect(listenFilterAccepts(filter, { kind: 'resources_list_changed' })).toBe(false);
        expect(listenFilterAccepts(filter, { kind: 'resource_updated', uri: 'file:///x' })).toBe(false);
    });
});

describe('honoredSubset', () => {
    it('keeps only explicitly-true / non-empty fields', () => {
        expect(honoredSubset({ toolsListChanged: true, promptsListChanged: false, resourceSubscriptions: ['file:///a'] })).toEqual({
            toolsListChanged: true,
            resourceSubscriptions: ['file:///a']
        });
    });

    it('returns an empty object for an all-absent / all-false filter', () => {
        expect(honoredSubset({})).toEqual({});
        expect(honoredSubset({ toolsListChanged: false, resourceSubscriptions: [] })).toEqual({});
    });

    it('does not alias the requested resourceSubscriptions array', () => {
        const requested = { resourceSubscriptions: ['file:///a'] };
        const honored = honoredSubset(requested);
        requested.resourceSubscriptions.push('file:///b');
        expect(honored.resourceSubscriptions).toEqual(['file:///a']);
    });
});

describe('serverEventToNotification', () => {
    it('maps each event kind onto its wire method', () => {
        expect(serverEventToNotification({ kind: 'tools_list_changed' })).toEqual({ method: 'notifications/tools/list_changed' });
        expect(serverEventToNotification({ kind: 'prompts_list_changed' })).toEqual({ method: 'notifications/prompts/list_changed' });
        expect(serverEventToNotification({ kind: 'resources_list_changed' })).toEqual({
            method: 'notifications/resources/list_changed'
        });
        expect(serverEventToNotification({ kind: 'resource_updated', uri: 'file:///a' })).toEqual({
            method: 'notifications/resources/updated',
            params: { uri: 'file:///a' }
        });
    });
});

describe('InMemoryServerEventBus', () => {
    it('delivers a published event to every registered listener', () => {
        const bus = new InMemoryServerEventBus();
        const a: string[] = [];
        const b: string[] = [];
        bus.subscribe(e => a.push(e.kind));
        bus.subscribe(e => b.push(e.kind));
        bus.publish({ kind: 'tools_list_changed' });
        expect(a).toEqual(['tools_list_changed']);
        expect(b).toEqual(['tools_list_changed']);
    });

    it('unsubscribe is idempotent and stops further delivery', () => {
        const bus = new InMemoryServerEventBus();
        const seen: string[] = [];
        const off = bus.subscribe(e => seen.push(e.kind));
        bus.publish({ kind: 'tools_list_changed' });
        off();
        off();
        bus.publish({ kind: 'prompts_list_changed' });
        expect(seen).toEqual(['tools_list_changed']);
        expect(bus.listenerCount).toBe(0);
    });

    it('a throwing listener does not stop delivery to peers; error surfaces via onerror', () => {
        const errors: Error[] = [];
        const bus = new InMemoryServerEventBus(e => errors.push(e));
        const seen: string[] = [];
        bus.subscribe(() => {
            throw new Error('boom');
        });
        bus.subscribe(e => seen.push(e.kind));
        bus.publish({ kind: 'tools_list_changed' });
        expect(seen).toEqual(['tools_list_changed']);
        expect(errors).toHaveLength(1);
        expect(errors[0]!.message).toBe('boom');
    });

    it('createServerNotifier publishes the matching event kind', () => {
        const bus = new InMemoryServerEventBus();
        const seen: unknown[] = [];
        bus.subscribe(e => seen.push(e));
        const notify = createServerNotifier(bus);
        notify.toolsChanged();
        notify.promptsChanged();
        notify.resourcesChanged();
        notify.resourceUpdated('file:///a');
        expect(seen).toEqual([
            { kind: 'tools_list_changed' },
            { kind: 'prompts_list_changed' },
            { kind: 'resources_list_changed' },
            { kind: 'resource_updated', uri: 'file:///a' }
        ]);
    });
});
