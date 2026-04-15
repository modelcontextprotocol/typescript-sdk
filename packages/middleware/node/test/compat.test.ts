import { describe, expect, expectTypeOf, it } from 'vitest';

import { NodeStreamableHTTPServerTransport, StreamableHTTPServerTransport } from '../src/index.js';
import type { EventId, EventStore, StreamId } from '../src/index.js';

describe('v1 compat exports from @modelcontextprotocol/node', () => {
    it('StreamableHTTPServerTransport aliases NodeStreamableHTTPServerTransport', () => {
        expect(StreamableHTTPServerTransport).toBe(NodeStreamableHTTPServerTransport);
        expectTypeOf<StreamableHTTPServerTransport>().toEqualTypeOf<NodeStreamableHTTPServerTransport>();
    });

    it('re-exports EventStore / EventId / StreamId types', () => {
        // Type-level assertions: these compile only if the types are exported.
        expectTypeOf<EventId>().toBeString();
        expectTypeOf<StreamId>().toBeString();
        expectTypeOf<EventStore>().toHaveProperty('storeEvent');
        expectTypeOf<EventStore>().toHaveProperty('replayEventsAfter');
    });
});
