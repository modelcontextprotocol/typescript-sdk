import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JSONRPCMessage } from '@modelcontextprotocol/server';

import { InMemoryEventStore } from '../src/inMemoryEventStore';

function notification(method: string): JSONRPCMessage {
    return { jsonrpc: '2.0', method };
}

async function replayAfter(store: InMemoryEventStore, lastEventId: string): Promise<{ streamId: string; replayed: string[] }> {
    const replayed: string[] = [];
    const streamId = await store.replayEventsAfter(lastEventId, {
        send: async eventId => {
            replayed.push(eventId);
        }
    });
    return { streamId, replayed };
}

describe('InMemoryEventStore', () => {
    beforeEach(() => {
        // `generateEventId` stamps each event with `Date.now()`, so two events
        // stored in the same millisecond can sort in either order and make the
        // replay assertions flaky. Pin timestamps to keep ordering deterministic.
        let now = 1000;
        vi.spyOn(Date, 'now').mockImplementation(() => now++);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('replays events after an event on a standalone GET stream whose ID starts with an underscore', async () => {
        const store = new InMemoryEventStore();
        const first = await store.storeEvent('_GET_stream', notification('notifications/message'));
        const second = await store.storeEvent('_GET_stream', notification('notifications/resources/updated'));

        const { streamId, replayed } = await replayAfter(store, first);

        expect(streamId).toBe('_GET_stream');
        expect(replayed).toEqual([second]);
    });

    it('replays events after an event on a regular stream ID', async () => {
        const store = new InMemoryEventStore();
        const first = await store.storeEvent('stream_1', notification('notifications/message'));
        const second = await store.storeEvent('stream_1', notification('notifications/resources/updated'));

        const { streamId, replayed } = await replayAfter(store, first);

        expect(streamId).toBe('stream_1');
        expect(replayed).toEqual([second]);
    });

    it('returns an empty string for an unknown last event ID', async () => {
        const store = new InMemoryEventStore();
        await store.storeEvent('_GET_stream', notification('notifications/message'));

        const { streamId, replayed } = await replayAfter(store, 'unknown-event-id');

        expect(streamId).toBe('');
        expect(replayed).toEqual([]);
    });

    it('returns an empty string for an empty store', async () => {
        const store = new InMemoryEventStore();

        const { streamId, replayed } = await replayAfter(store, 'anything');

        expect(streamId).toBe('');
        expect(replayed).toEqual([]);
    });
});
