/**
 * Self-contained test bodies for hosting resume (StreamableHTTP resumability/EventStore).
 *
 * Each export is a {@link TestCase}: it builds its own server (via a factory),
 * builds its own client, wires them with {@link wire}, and asserts. SSE stream
 * parsing and raw GET requests drive resume scenarios.
 */

import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { Client } from '../../../src/client/index.js';
import { StreamableHTTPClientTransport } from '../../../src/client/streamableHttp.js';
import type { EventStore, EventId, StreamId } from '../../../src/server/webStandardStreamableHttp.js';
import { McpServer } from '../../../src/server/mcp.js';
import type { JSONRPCMessage } from '../../../src/types.js';

import { hostResumable } from '../helpers/index.js';
import type { TestArgs } from '../types.js';
import { LATEST_PROTOCOL_VERSION } from '../../../src/types.js';
import { verifies } from '../helpers/verifies.js';

/**
 * These three tests assert the raw frame sequence of the POST SSE stream itself, so they cannot run their traffic through a connected client.
 */
async function completeHandshake(
    url: URL,
    fetch: (u: URL | string, init?: RequestInit) => Promise<Response>,
    capabilities: Record<string, unknown> = {}
): Promise<{ sessionId: string; baseHeaders: Record<string, string> }> {
    const initRes = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities,
                clientInfo: { name: 'test', version: '0' }
            }
        })
    });

    if (!initRes.ok) throw new Error(`Initialize failed: ${initRes.status}`);

    const sessionId = initRes.headers.get('mcp-session-id');
    if (!sessionId) throw new Error('No session ID in initialize response');

    await initRes.body?.cancel();

    const baseHeaders = { 'mcp-session-id': sessionId, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION };

    const notifRes = await fetch(url, {
        method: 'POST',
        headers: {
            ...baseHeaders,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized'
        })
    });

    if (!notifRes.ok) throw new Error(`notifications/initialized failed: ${notifRes.status}`);
    await notifRes.body?.cancel();

    return { sessionId, baseHeaders };
}

/**
 * Minimal in-memory EventStore for tests. Models user implementation.
 * Ids are `<streamId>_<seq>` for deterministic ordering.
 */
class InMemoryEventStore implements EventStore {
    private events: Array<{ id: string; streamId: string; message: JSONRPCMessage }> = [];
    private seq = 0;

    async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
        const id = `${streamId}_${String(this.seq++).padStart(6, '0')}`;
        this.events.push({ id, streamId, message });
        return id;
    }

    async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
        const found = this.events.find(e => e.id === eventId);
        return found?.streamId;
    }

    async replayEventsAfter(
        lastEventId: EventId,
        { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> }
    ): Promise<StreamId> {
        const idx = this.events.findIndex(e => e.id === lastEventId);
        if (idx < 0) return '';
        const streamId = this.events[idx].streamId;
        for (const e of this.events.slice(idx + 1)) {
            if (e.streamId === streamId) await send(e.id, e.message);
        }
        return streamId;
    }

    reset(): void {
        this.events.length = 0;
        this.seq = 0;
    }

    getStoredEvents(): ReadonlyArray<{ id: string; streamId: string; message: JSONRPCMessage }> {
        return this.events;
    }
}

/** Parse SSE blocks with non-empty data lines from an SSE body. */
function parseSseFrames(body: string): Array<{ id: string; data: string }> {
    const frames: Array<{ id: string; data: string }> = [];
    for (const block of body.split(/\r?\n\r?\n/)) {
        const idMatch = block.match(/^id:\s*(.+)$/m);
        const dataMatch = block.match(/^data:\s*(.+)$/m);
        if (idMatch?.[1]?.trim() && dataMatch?.[1]) {
            frames.push({ id: idMatch[1].trim(), data: dataMatch[1] });
        }
    }
    return frames;
}

/** Read an SSE Response body to completion. */
async function readSseBody(body: ReadableStream<Uint8Array>): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (value) buf += decoder.decode(value, { stream: true });
            if (done) break;
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
    return buf;
}

/** Read SSE frames until we have at least `count` frames, then cancel. */
async function readSseFramesUntil(body: ReadableStream<Uint8Array>, count: number, maxIterations = 64): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
        for (let i = 0; i < maxIterations; i++) {
            const { value, done } = await reader.read();
            if (value) buf += decoder.decode(value, { stream: true });
            const frames = parseSseFrames(buf);
            if (frames.length >= count) break;
            if (done) break;
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
    return buf;
}

verifies('hosting:resume:event-ids', async (_args: TestArgs) => {
    const eventStore = new InMemoryEventStore();

    let serverRef: McpServer | undefined;

    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' }, { capabilities: { logging: {} } });
        s.registerTool('progress', { inputSchema: z.object({ steps: z.number().int().positive() }) }, async ({ steps }, extra) => {
            const token = extra._meta?.progressToken;
            if (token !== undefined) {
                for (let i = 1; i <= steps; i++) {
                    await extra.sendNotification({
                        method: 'notifications/progress',
                        params: { progressToken: token, progress: i, total: steps }
                    });
                }
            }
            return { content: [{ type: 'text', text: `done ${steps}` }] };
        });
        serverRef = s;
        return s;
    };

    const handle = hostResumable(makeServer, { eventStore });

    const url = new URL('http://in-process/mcp');
    const fetch = (u: URL | string, init?: RequestInit) => handle.handleRequest(new Request(u, init));

    try {
        const { baseHeaders } = await completeHandshake(url, fetch, { logging: {} });

        if (!serverRef) throw new Error('serverRef not set');

        const postRes = await fetch(url, {
            method: 'POST',
            headers: { ...baseHeaders, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'evt-1',
                method: 'tools/call',
                params: { name: 'progress', arguments: { steps: 3 }, _meta: { progressToken: 'evt-1' } }
            })
        });
        expect(postRes.status).toBe(200);
        expect(postRes.headers.get('content-type')).toMatch(/text\/event-stream/);

        const postBody = await readSseBody(postRes.body!);

        const postBlocks = postBody.split(/\r?\n\r?\n/).filter(b => b.trim().length > 0);
        expect(postBlocks).toHaveLength(5);
        const postIds = postBlocks.map(b => b.match(/^id: (\S+)$/m)?.[1]).filter((id): id is string => id !== undefined);
        expect(postIds).toHaveLength(postBlocks.length);

        const postMessages = postBlocks
            .map(b => b.match(/^data: (.+)$/m)?.[1])
            .filter((d): d is string => d !== undefined && d.trim().length > 0)
            .map(d => JSON.parse(d) as JSONRPCMessage);
        expect(postMessages.filter(m => 'method' in m && m.method === 'notifications/progress')).toHaveLength(3);
        expect(postMessages.filter(m => 'id' in m && m.id === 'evt-1')).toHaveLength(1);

        const getRes = await fetch(url, {
            method: 'GET',
            headers: { ...baseHeaders, accept: 'application/json, text/event-stream' }
        });
        expect(getRes.status).toBe(200);
        expect(getRes.headers.get('content-type')).toMatch(/text\/event-stream/);

        await serverRef.sendLoggingMessage({ level: 'info', data: 'standalone-1' });
        await serverRef.sendLoggingMessage({ level: 'warning', data: 'standalone-2' });

        const getBuf = await readSseFramesUntil(getRes.body!, 2);

        const getBlocks = getBuf.split(/\r?\n\r?\n/).filter(b => b.trim().length > 0);
        expect(getBlocks).toHaveLength(2);
        const getIds = getBlocks.map(b => b.match(/^id: (\S+)$/m)?.[1]).filter((id): id is string => id !== undefined);
        expect(getIds).toHaveLength(getBlocks.length);

        const storedIds = eventStore.getStoredEvents().map(e => e.id);
        for (const id of [...postIds, ...getIds]) {
            expect(storedIds).toContain(id);
        }
    } finally {
        await handle.close();
    }
});

verifies('hosting:resume:replay', async (_args: TestArgs) => {
    const eventStore = new InMemoryEventStore();

    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('progress', { inputSchema: z.object({ steps: z.number().int().positive() }) }, async ({ steps }, extra) => {
            const token = extra._meta?.progressToken;
            if (token !== undefined) {
                for (let i = 1; i <= steps; i++) {
                    await extra.sendNotification({
                        method: 'notifications/progress',
                        params: { progressToken: token, progress: i, total: steps }
                    });
                }
            }
            return { content: [{ type: 'text', text: `done ${steps}` }] };
        });
        return s;
    };

    const handle = hostResumable(makeServer, { eventStore });

    const url = new URL('http://in-process/mcp');
    const fetch = (u: URL | string, init?: RequestInit) => handle.handleRequest(new Request(u, init));

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(url, { fetch });

    try {
        await client.connect(transport);

        const sessionId = transport.sessionId!;
        const baseHeaders = { 'mcp-session-id': sessionId };

        const postRes = await fetch(url, {
            method: 'POST',
            headers: { ...baseHeaders, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'replay-1',
                method: 'tools/call',
                params: { name: 'progress', arguments: { steps: 3 }, _meta: { progressToken: 'replay-1' } }
            })
        });
        expect(postRes.status).toBe(200);
        const postBody = await readSseBody(postRes.body!);
        const originalFrames = parseSseFrames(postBody);
        expect(originalFrames.length).toBeGreaterThanOrEqual(2);

        const anchorId = originalFrames[0].id;
        const expectedAfterIds = originalFrames.slice(1).map(f => f.id);

        const resumeRes = await fetch(url, {
            method: 'GET',
            headers: { ...baseHeaders, accept: 'application/json, text/event-stream', 'last-event-id': anchorId }
        });
        expect(resumeRes.status).toBe(200);
        expect(resumeRes.headers.get('content-type')).toMatch(/text\/event-stream/);

        const resumeBody = await readSseFramesUntil(resumeRes.body!, expectedAfterIds.length);
        const replayedFrames = parseSseFrames(resumeBody);
        const replayedIds = replayedFrames.map(f => f.id);

        expect(replayedIds).toEqual(expectedAfterIds);
        expect(replayedIds).not.toContain(anchorId);

        for (const f of replayedFrames) {
            const msg = JSON.parse(f.data) as JSONRPCMessage;
            expect(msg).toHaveProperty('jsonrpc', '2.0');
        }
    } finally {
        await client.close();
        await handle.close();
    }
});

verifies('hosting:resume:buffered-replay', async (_args: TestArgs) => {
    const eventStore = new InMemoryEventStore();

    let serverRef: McpServer | undefined;

    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' }, { capabilities: { logging: {} } });
        serverRef = s;
        return s;
    };

    const handle = hostResumable(makeServer, { eventStore });

    const url = new URL('http://in-process/mcp');
    const fetch = (u: URL | string, init?: RequestInit) => handle.handleRequest(new Request(u, init));

    try {
        const initRes = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'init-1',
                method: 'initialize',
                params: { protocolVersion: '2024-11-05', capabilities: { logging: {} }, clientInfo: { name: 'c', version: '0' } }
            })
        });
        expect(initRes.status).toBe(200);
        const sessionId = initRes.headers.get('mcp-session-id');
        expect(sessionId).toBeTruthy();

        await readSseBody(initRes.body!);

        const baseHeaders = { 'mcp-session-id': sessionId! };

        await fetch(url, {
            method: 'POST',
            headers: { ...baseHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'notifications/initialized',
                params: {}
            })
        });

        if (!serverRef) throw new Error('serverRef not set');

        const getRes = await fetch(url, {
            method: 'GET',
            headers: { ...baseHeaders, accept: 'application/json, text/event-stream' }
        });
        expect(getRes.status).toBe(200);

        const reader = getRes.body!.getReader();
        const decoder = new TextDecoder();
        let anchorBuf = '';

        await serverRef.sendLoggingMessage({ level: 'info', data: 'anchor' });

        try {
            for (let i = 0; i < 32; i++) {
                const { value, done } = await reader.read();
                if (value) anchorBuf += decoder.decode(value, { stream: true });
                const frames = parseSseFrames(anchorBuf);
                if (frames.length >= 1) break;
                if (done) break;
            }
        } finally {
            await reader.cancel().catch(() => {});
        }

        const anchorFrames = parseSseFrames(anchorBuf);
        expect(anchorFrames.length).toBeGreaterThanOrEqual(1);
        const anchorId = anchorFrames[anchorFrames.length - 1].id;

        await serverRef.sendLoggingMessage({ level: 'info', data: 'buffered-1' });
        await serverRef.sendLoggingMessage({ level: 'warning', data: 'buffered-2' });
        await serverRef.sendLoggingMessage({ level: 'error', data: 'buffered-3' });

        const resumeRes = await fetch(url, {
            method: 'GET',
            headers: { ...baseHeaders, accept: 'application/json, text/event-stream', 'last-event-id': anchorId }
        });
        expect(resumeRes.status).toBe(200);

        const resumeBody = await readSseFramesUntil(resumeRes.body!, 3);
        const replayedFrames = parseSseFrames(resumeBody);
        expect(replayedFrames.length).toBeGreaterThanOrEqual(3);

        const logData = replayedFrames
            .map(f => {
                const msg = JSON.parse(f.data) as JSONRPCMessage;
                if ('method' in msg && msg.method === 'notifications/message' && 'params' in msg) {
                    const params = msg.params as { data: unknown };
                    return params.data;
                }
                return undefined;
            })
            .filter((d): d is unknown => d !== undefined);

        expect(logData.slice(0, 3)).toEqual(['buffered-1', 'buffered-2', 'buffered-3']);
        expect(logData).not.toContain('anchor');
    } finally {
        await handle.close();
    }
});

verifies('typescript:hosting:resume:bad-event-id', async (_args: TestArgs) => {
    const UNMAPPABLE_EVENT_ID = 'evt-unmappable';
    const THROWING_EVENT_ID = 'evt-replay-throws';

    const scriptedEventStore: EventStore = {
        async storeEvent(streamId) {
            return `${streamId}_stored`;
        },
        async getStreamIdForEventId(eventId) {
            if (eventId === UNMAPPABLE_EVENT_ID) return undefined;
            if (eventId === THROWING_EVENT_ID) return 'stream-will-throw';
            return undefined;
        },
        async replayEventsAfter(lastEventId) {
            if (lastEventId === THROWING_EVENT_ID) {
                throw new Error('boom: replay failed');
            }
            return 'unused-stream';
        }
    };

    const makeServer = () => new McpServer({ name: 's', version: '0' });

    const handle = hostResumable(makeServer, { eventStore: scriptedEventStore });

    const url = new URL('http://in-process/mcp');
    const fetch = (u: URL | string, init?: RequestInit) => handle.handleRequest(new Request(u, init));

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(url, { fetch });

    try {
        await client.connect(transport);

        const sessionId = transport.sessionId!;
        const baseHeaders = { 'mcp-session-id': sessionId };

        const unmappedRes = await fetch(url, {
            method: 'GET',
            headers: { ...baseHeaders, accept: 'application/json, text/event-stream', 'last-event-id': UNMAPPABLE_EVENT_ID }
        });
        expect(unmappedRes.status).toBe(400);
        const unmappedBody = await unmappedRes.json();
        expect(unmappedBody.error?.code).toBe(-32000);

        const failedRes = await fetch(url, {
            method: 'GET',
            headers: { ...baseHeaders, accept: 'application/json, text/event-stream', 'last-event-id': THROWING_EVENT_ID }
        });
        expect(failedRes.status).toBe(500);
        const failedBody = await failedRes.json();
        expect(failedBody.error?.code).toBe(-32000);
    } finally {
        await client.close();
        await handle.close();
    }
});

verifies('hosting:resume:priming', async (_args: TestArgs) => {
    const RETRY_MS = 7331;
    const eventStore = new InMemoryEventStore();

    const makeServer = () => new McpServer({ name: 's', version: '0' });

    const handle = hostResumable(makeServer, {
        eventStore,
        retryInterval: RETRY_MS
    });

    const url = new URL('http://in-process/mcp');
    const fetch = (u: URL | string, init?: RequestInit) => handle.handleRequest(new Request(u, init));

    try {
        const { baseHeaders } = await completeHandshake(url, fetch);

        const postRes = await fetch(url, {
            method: 'POST',
            headers: { ...baseHeaders, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'priming-probe',
                method: 'tools/list',
                params: {}
            })
        });

        expect(postRes.status).toBe(200);
        expect(postRes.headers.get('content-type')).toMatch(/text\/event-stream/);

        const body = await readSseBody(postRes.body!);
        const events = body.split('\n\n').filter(e => e.trim().length > 0);
        expect(events.length).toBeGreaterThanOrEqual(2);

        const priming = events[0];
        const primingLines = priming.split('\n');

        const idLine = primingLines.find(l => l.startsWith('id:'));
        expect(idLine).toBeDefined();
        expect(idLine!.slice('id:'.length).trim().length).toBeGreaterThan(0);

        expect(primingLines).toContain(`retry: ${RETRY_MS}`);

        const dataLine = primingLines.find(l => l.startsWith('data:'));
        expect(dataLine).toBeDefined();
        expect(dataLine!.replace(/^data:\s?/, '')).toBe('');

        expect(priming).not.toMatch(/^event: message$/m);

        const responseEvent = events.find(e => /^event: message$/m.test(e));
        expect(responseEvent).toBeDefined();
        expect(events.indexOf(responseEvent!)).toBeGreaterThan(0);
    } finally {
        await handle.close();
    }
});

verifies('hosting:resume:stream-scoped', async (_args: TestArgs) => {
    const eventStore = new InMemoryEventStore();

    let serverRef: McpServer | undefined;

    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' }, { capabilities: { logging: {} } });
        s.registerTool('progress', { inputSchema: z.object({ steps: z.number().int().positive() }) }, async ({ steps }, extra) => {
            const token = extra._meta?.progressToken;
            if (token !== undefined) {
                for (let i = 1; i <= steps; i++) {
                    await extra.sendNotification({
                        method: 'notifications/progress',
                        params: { progressToken: token, progress: i, total: steps }
                    });
                }
            }
            return { content: [{ type: 'text', text: `done ${steps}` }] };
        });
        serverRef = s;
        return s;
    };

    const handle = hostResumable(makeServer, { eventStore });

    const url = new URL('http://in-process/mcp');
    const fetch = (u: URL | string, init?: RequestInit) => handle.handleRequest(new Request(u, init));

    try {
        const initRes = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'init-1',
                method: 'initialize',
                params: { protocolVersion: '2024-11-05', capabilities: { logging: {} }, clientInfo: { name: 'c', version: '0' } }
            })
        });
        expect(initRes.status).toBe(200);
        const sessionId = initRes.headers.get('mcp-session-id');
        expect(sessionId).toBeTruthy();

        await readSseBody(initRes.body!);

        const baseHeaders = { 'mcp-session-id': sessionId! };

        await fetch(url, {
            method: 'POST',
            headers: { ...baseHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'notifications/initialized',
                params: {}
            })
        });

        const getRes = await fetch(url, {
            method: 'GET',
            headers: { ...baseHeaders, accept: 'application/json, text/event-stream' }
        });
        expect(getRes.status).toBe(200);

        const reader = getRes.body!.getReader();
        const decoder = new TextDecoder();
        let anchorBuf = '';

        if (!serverRef) throw new Error('serverRef not set');
        await serverRef.sendLoggingMessage({ level: 'info', data: 'anchor' });

        try {
            for (let i = 0; i < 32; i++) {
                const { value, done } = await reader.read();
                if (value) anchorBuf += decoder.decode(value, { stream: true });
                const frames = parseSseFrames(anchorBuf);
                if (frames.length >= 1) break;
                if (done) break;
            }
        } finally {
            await reader.cancel().catch(() => {});
        }

        const anchorFrames = parseSseFrames(anchorBuf);
        expect(anchorFrames.length).toBeGreaterThanOrEqual(1);
        const anchorId = anchorFrames[anchorFrames.length - 1].id;
        const stored = eventStore.getStoredEvents();
        const anchorEvent = stored.find(e => e.id === anchorId);
        expect(anchorEvent).toBeDefined();
        const streamAId = anchorEvent!.streamId;

        const postRes = await fetch(url, {
            method: 'POST',
            headers: { ...baseHeaders, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'prog-1',
                method: 'tools/call',
                params: { name: 'progress', arguments: { steps: 2 }, _meta: { progressToken: 'prog-1' } }
            })
        });
        expect(postRes.status).toBe(200);
        await readSseBody(postRes.body!);

        const storedAfterProgress = eventStore.getStoredEvents();
        const streamBEvents = storedAfterProgress.filter(e => e.streamId !== streamAId);
        expect(streamBEvents.length).toBeGreaterThan(0);

        await serverRef.sendLoggingMessage({ level: 'info', data: 'after-1' });
        await serverRef.sendLoggingMessage({ level: 'warning', data: 'after-2' });

        const resumeRes = await fetch(url, {
            method: 'GET',
            headers: { ...baseHeaders, accept: 'application/json, text/event-stream', 'last-event-id': anchorId }
        });
        expect(resumeRes.status).toBe(200);

        const resumeReader = resumeRes.body!.getReader();
        const resumeDecoder = new TextDecoder();
        let resumeBuf = '';
        const readResumedUntil = async (haveEnough: (frames: ReturnType<typeof parseSseFrames>) => boolean) => {
            for (let i = 0; i < 64 && !haveEnough(parseSseFrames(resumeBuf)); i++) {
                const { value, done } = await resumeReader.read();
                if (value) resumeBuf += resumeDecoder.decode(value, { stream: true });
                if (done) break;
            }
            return parseSseFrames(resumeBuf);
        };

        try {
            const replayedFrames = await readResumedUntil(frames => frames.length >= 2);
            expect(replayedFrames.length).toBeGreaterThanOrEqual(2);

            const replayedEvents = replayedFrames.map(f => ({
                id: f.id,
                message: JSON.parse(f.data) as JSONRPCMessage
            }));

            const storedFinal = eventStore.getStoredEvents();
            const eventIdToStream = new Map(storedFinal.map(e => [e.id, e.streamId]));
            for (const r of replayedEvents) {
                expect(eventIdToStream.get(r.id)).toBe(streamAId);
            }

            const replayedMethods = replayedEvents
                .map(r => ('method' in r.message ? r.message.method : undefined))
                .filter((m): m is string => m !== undefined);
            expect(replayedMethods).not.toContain('notifications/progress');

            const logData = replayedEvents
                .map(r => {
                    if ('method' in r.message && r.message.method === 'notifications/message' && 'params' in r.message) {
                        const params = r.message.params as { data: unknown };
                        return params.data;
                    }
                    return undefined;
                })
                .filter((d): d is unknown => d !== undefined);
            expect(logData.slice(0, 2)).toEqual(['after-1', 'after-2']);
            expect(logData).not.toContain('anchor');

            const livePostRes = await fetch(url, {
                method: 'POST',
                headers: { ...baseHeaders, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 'live-1',
                    method: 'tools/call',
                    params: { name: 'progress', arguments: { steps: 2 }, _meta: { progressToken: 'live-1' } }
                })
            });
            expect(livePostRes.status).toBe(200);
            expect(livePostRes.headers.get('content-type')).toMatch(/text\/event-stream/);

            const liveMessages = parseSseFrames(await readSseBody(livePostRes.body!))
                .filter(f => f.data.trim().length > 0)
                .map(f => JSON.parse(f.data) as JSONRPCMessage);
            expect(liveMessages.filter(m => 'method' in m && m.method === 'notifications/progress')).toHaveLength(2);
            expect(liveMessages.filter(m => 'id' in m && m.id === 'live-1')).toHaveLength(1);

            await serverRef.sendLoggingMessage({ level: 'info', data: 'sentinel' });
            const resumedFrames = await readResumedUntil(frames =>
                frames.some(f => {
                    const m = JSON.parse(f.data) as JSONRPCMessage;
                    return 'method' in m && m.method === 'notifications/message' && (m.params as { data?: unknown })?.data === 'sentinel';
                })
            );
            const resumedMessages = resumedFrames.map(f => JSON.parse(f.data) as JSONRPCMessage);
            expect(
                resumedMessages.some(
                    m => 'method' in m && m.method === 'notifications/message' && (m.params as { data?: unknown })?.data === 'sentinel'
                )
            ).toBe(true);
            expect(resumedMessages.filter(m => 'method' in m && m.method === 'notifications/progress')).toHaveLength(0);
            expect(resumedMessages.filter(m => 'id' in m && m.id === 'live-1')).toHaveLength(0);
        } finally {
            await resumeReader.cancel().catch(() => {});
        }
    } finally {
        await handle.close();
    }
});

verifies('hosting:resume:close-stream', async (_args: TestArgs) => {
    const eventStore = new InMemoryEventStore();

    const hooksSeen: Array<{ closeRequestStream: boolean; closeStandalone: boolean }> = [];
    let releaseTool: () => void = () => {};
    const toolGate = new Promise<void>(resolve => {
        releaseTool = resolve;
    });

    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('generate-report', { inputSchema: z.object({}) }, async (_input, extra) => {
            hooksSeen.push({
                closeRequestStream: typeof extra.closeSSEStream === 'function',
                closeStandalone: typeof extra.closeStandaloneSSEStream === 'function'
            });
            extra.closeStandaloneSSEStream?.();
            extra.closeSSEStream?.();
            await toolGate;
            return { content: [{ type: 'text', text: 'report ready' }] };
        });
        return s;
    };

    const handle = hostResumable(makeServer, { eventStore });

    const url = new URL('http://in-process/mcp');
    const fetch = (u: URL | string, init?: RequestInit) => handle.handleRequest(new Request(u, init));

    try {
        const { baseHeaders } = await completeHandshake(url, fetch);

        const standaloneRes = await fetch(url, {
            method: 'GET',
            headers: { ...baseHeaders, accept: 'application/json, text/event-stream' }
        });
        expect(standaloneRes.status).toBe(200);
        expect(standaloneRes.headers.get('content-type')).toMatch(/text\/event-stream/);

        const postRes = await fetch(url, {
            method: 'POST',
            headers: { ...baseHeaders, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'close-1',
                method: 'tools/call',
                params: { name: 'generate-report', arguments: {} }
            })
        });
        expect(postRes.status).toBe(200);
        expect(postRes.headers.get('content-type')).toMatch(/text\/event-stream/);

        await vi.waitFor(() => expect(hooksSeen).toHaveLength(1));
        expect(hooksSeen[0]).toEqual({ closeRequestStream: true, closeStandalone: true });

        const postBody = await readSseBody(postRes.body!);
        const standaloneBody = await readSseBody(standaloneRes.body!);

        expect(standaloneBody).toBe('');
        expect(postBody).not.toMatch(/^event: message$/m);

        const primingIdMatch = postBody.match(/^id:\s*(.+)$/m);
        expect(primingIdMatch?.[1]?.trim()).toBeTruthy();
        const primingId = primingIdMatch![1].trim();

        const resumeRes = await fetch(url, {
            method: 'GET',
            headers: { ...baseHeaders, accept: 'application/json, text/event-stream', 'last-event-id': primingId }
        });
        expect(resumeRes.status).toBe(200);
        expect(resumeRes.headers.get('content-type')).toMatch(/text\/event-stream/);

        releaseTool();

        const resumeBody = await readSseBody(resumeRes.body!);
        const resumeFrames = parseSseFrames(resumeBody);
        expect(resumeFrames).toHaveLength(1);

        const response: unknown = JSON.parse(resumeFrames[0].data);
        expect(response).toMatchObject({
            jsonrpc: '2.0',
            id: 'close-1',
            result: { content: [{ type: 'text', text: 'report ready' }] }
        });
    } finally {
        releaseTool();
        await handle.close();
    }
});
