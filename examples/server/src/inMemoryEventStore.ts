import type { EventStore, JSONRPCMessage } from '@modelcontextprotocol/server';

/**
 * Simple in-memory implementation of the EventStore interface for resumability
 * This is primarily intended for examples and testing, not for production use
 * where a persistent storage solution would be more appropriate.
 */
export class InMemoryEventStore implements EventStore {
    private events: Map<string, { streamId: string; message: JSONRPCMessage }> = new Map();

    /**
     * Generates a unique event ID for a given stream ID
     */
    private generateEventId(streamId: string): string {
        return `${streamId}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }

    /**
     * Stores an event with a generated event ID
     * Implements EventStore.storeEvent
     */
    async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
        const eventId = this.generateEventId(streamId);
        this.events.set(eventId, { streamId, message });
        return eventId;
    }

    /**
     * Replays events that occurred after a specific event ID
     * Implements EventStore.replayEventsAfter
     */
    async replayEventsAfter(
        lastEventId: string,
        { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> }
    ): Promise<string> {
        if (!lastEventId || !this.events.has(lastEventId)) {
            return '';
        }

        const streamId = this.events.get(lastEventId)?.streamId ?? '';
        if (!streamId) {
            return '';
        }

        let foundLastEvent = false;

        // Map preserves insertion order, which is the event creation order. The
        // generated IDs include a random suffix, so lexicographic sorting can
        // reorder events created in the same millisecond.
        for (const [eventId, { streamId: eventStreamId, message }] of this.events) {
            // Only include events from the same stream
            if (eventStreamId !== streamId) {
                continue;
            }

            // Start sending events after we find the lastEventId
            if (eventId === lastEventId) {
                foundLastEvent = true;
                continue;
            }

            if (foundLastEvent) {
                await send(eventId, message);
            }
        }
        return streamId;
    }
}
