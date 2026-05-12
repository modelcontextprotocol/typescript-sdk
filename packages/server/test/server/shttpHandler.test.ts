import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/core';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core';
import { describe, expect, test } from 'vitest';

import { SessionCompat } from '../../src/server/sessionCompat.js';
import { shttpHandler } from '../../src/server/shttpHandler.js';
import type { EventId, EventStore, StreamId } from '../../src/server/streamableHttp.js';

function makeEventStore(): { store: EventStore; events: Map<EventId, { streamId: StreamId; message: JSONRPCMessage }> } {
    const events = new Map<EventId, { streamId: StreamId; message: JSONRPCMessage }>();
    let n = 0;
    const store: EventStore = {
        async storeEvent(streamId, message) {
            const id = `${streamId}::${n++}`;
            events.set(id, { streamId, message });
            return id;
        },
        async getStreamIdForEventId(eventId) {
            return events.get(eventId)?.streamId;
        },
        async replayEventsAfter(lastEventId, { send }) {
            const last = events.get(lastEventId);
            if (!last) throw new Error('unknown event');
            let after = false;
            for (const [id, ev] of events) {
                if (id === lastEventId) {
                    after = true;
                    continue;
                }
                if (after && ev.streamId === last.streamId) await send(id, ev.message);
            }
            return last.streamId;
        }
    };
    return { store, events };
}

function initRequest(): Request {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '0' } }
        })
    });
}

function pingRequest(sessionId: string): Request {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-session-id': sessionId,
            'mcp-protocol-version': LATEST_PROTOCOL_VERSION
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })
    });
}

function getWithLastEventId(sessionId: string, lastEventId: string): Request {
    return new Request('http://localhost/mcp', {
        method: 'GET',
        headers: {
            accept: 'text/event-stream',
            'mcp-session-id': sessionId,
            'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
            'last-event-id': lastEventId
        }
    });
}

const onrequest = async function* (r: JSONRPCRequest): AsyncIterable<JSONRPCMessage> {
    yield { jsonrpc: '2.0', id: r.id, result: {} };
};

async function firstEventId(res: Response): Promise<string> {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (value) buf += dec.decode(value, { stream: true });
        const m = /^id: (.+)$/m.exec(buf);
        if (m) {
            await reader.cancel();
            return m[1]!;
        }
        if (done) throw new Error('stream ended without an id: line');
    }
}

describe('shttpHandler — Last-Event-ID replay session binding', () => {
    test('rejects replay of an event ID belonging to another session', async () => {
        const { store } = makeEventStore();
        const session = new SessionCompat();
        const handler = shttpHandler({ onrequest }, { session, eventStore: store });

        // Session A: initialize, then make a POST whose SSE stream gets a stored event ID.
        const initA = await handler(initRequest());
        const sidA = initA.headers.get('mcp-session-id')!;
        await initA.body?.cancel();
        const postA = await handler(pingRequest(sidA));
        expect(postA.headers.get('content-type')).toBe('text/event-stream');
        const eventIdA = await firstEventId(postA);

        // Session B: initialize.
        const initB = await handler(initRequest());
        const sidB = initB.headers.get('mcp-session-id')!;
        await initB.body?.cancel();
        expect(sidB).not.toBe(sidA);

        // B attempts to replay A's event — must be rejected.
        const replayCross = await handler(getWithLastEventId(sidB, eventIdA));
        expect(replayCross.status).toBe(403);

        // A replaying its own event is permitted.
        const replayOwn = await handler(getWithLastEventId(sidA, eventIdA));
        expect(replayOwn.status).toBe(200);
        await replayOwn.body?.cancel();
    });

    test('rejects replay of an unknown event ID', async () => {
        const { store } = makeEventStore();
        const session = new SessionCompat();
        const handler = shttpHandler({ onrequest }, { session, eventStore: store });

        const init = await handler(initRequest());
        const sid = init.headers.get('mcp-session-id')!;
        await init.body?.cancel();

        const res = await handler(getWithLastEventId(sid, 'no-such-stream::42'));
        expect(res.status).toBe(404);
    });

    test('fails closed when eventStore lacks getStreamIdForEventId', async () => {
        const events = new Map<EventId, { streamId: StreamId; message: JSONRPCMessage }>();
        const store: EventStore = {
            async storeEvent(streamId, message) {
                const id = `${streamId}::${events.size}`;
                events.set(id, { streamId, message });
                return id;
            },
            async replayEventsAfter() {
                return 'x';
            }
        };
        const session = new SessionCompat();
        const handler = shttpHandler({ onrequest }, { session, eventStore: store });

        const init = await handler(initRequest());
        const sid = init.headers.get('mcp-session-id')!;
        await init.body?.cancel();
        const post = await handler(pingRequest(sid));
        const eventId = await firstEventId(post);

        const res = await handler(getWithLastEventId(sid, eventId));
        expect(res.status).toBe(403);
    });
});
