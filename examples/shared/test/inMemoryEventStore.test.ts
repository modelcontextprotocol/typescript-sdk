import { describe, expect, it } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/server';
import { InMemoryEventStore } from '../src/inMemoryEventStore';

describe('InMemoryEventStore', () => {
    it('resumes the standalone GET stream in event insertion order', async () => {
        const store = new InMemoryEventStore();
        const streamId = '_GET_stream';
        const firstMessage: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'test/event1',
            params: {}
        };
        const secondMessage: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'test/event2',
            params: {}
        };
        const thirdMessage: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'test/event3',
            params: {}
        };

        const firstEventId = await store.storeEvent(streamId, firstMessage);
        const secondEventId = await store.storeEvent(streamId, secondMessage);
        const thirdEventId = await store.storeEvent(streamId, thirdMessage);

        const replayedEvents: { eventId: string; message: JSONRPCMessage }[] = [];
        const returnedStreamId = await store.replayEventsAfter(firstEventId, {
            send: async (eventId, message) => {
                replayedEvents.push({ eventId, message });
            }
        });

        expect(returnedStreamId).toBe(streamId);
        expect(replayedEvents).toEqual([
            { eventId: secondEventId, message: secondMessage },
            { eventId: thirdEventId, message: thirdMessage }
        ]);
    });
});
