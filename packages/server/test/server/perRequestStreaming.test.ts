/**
 * Per-request streaming behavior: the lazy JSON-to-SSE upgrade, sink
 * discipline (write order, drain-before-finalize, post-close drops), the
 * forced response modes the entry-level knob will plug into, comment-frame
 * support, and disconnect-as-cancellation.
 */
import type { CallToolResult, JSONRPCRequest, MessageClassification, ServerContext } from '@modelcontextprotocol/core';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    PROTOCOL_VERSION_META_KEY,
    setNegotiatedProtocolVersion
} from '@modelcontextprotocol/core';
import { describe, expect, it } from 'vitest';

import type { PerRequestResponseMode } from '../../src/server/perRequestTransport.js';
import { PerRequestHTTPServerTransport } from '../../src/server/perRequestTransport.js';
import { Server } from '../../src/server/server.js';

const MODERN_REVISION = '2026-07-28';
const MODERN: MessageClassification = { era: 'modern', revision: MODERN_REVISION };

const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
    [CLIENT_INFO_META_KEY]: { name: 'streaming-test-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};

const toolsCall = (id = 1): JSONRPCRequest =>
    ({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'echo', arguments: {}, _meta: ENVELOPE }
    }) as JSONRPCRequest;

const progressNotification = (progress: number) => ({
    method: 'notifications/progress' as const,
    params: { progressToken: 'stream-test', progress }
});

interface StreamingSetup {
    server: Server;
    transport: PerRequestHTTPServerTransport;
}

async function setup(
    handler: (ctx: ServerContext) => Promise<CallToolResult>,
    responseMode?: PerRequestResponseMode
): Promise<StreamingSetup> {
    const server = new Server({ name: 'streaming-test', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/call', async (_request, ctx) => handler(ctx));
    setNegotiatedProtocolVersion(server, MODERN_REVISION);
    const transport = new PerRequestHTTPServerTransport({
        classification: MODERN,
        ...(responseMode !== undefined && { responseMode })
    });
    await server.connect(transport);
    return { server, transport };
}

/** SSE frames of a fully-drained response body, split on the blank-line separator. */
async function sseFrames(response: Response): Promise<string[]> {
    const text = await response.text();
    return text
        .split('\n\n')
        .map(frame => frame.trim())
        .filter(frame => frame.length > 0);
}

const dataOf = (frame: string): unknown => {
    const dataLine = frame.split('\n').find(line => line.startsWith('data: '));
    return dataLine === undefined ? undefined : JSON.parse(dataLine.slice('data: '.length));
};

describe('lazy upgrade matrix', () => {
    it('answers a handler with no streamed output as a single JSON body', async () => {
        const { transport } = await setup(async () => ({ content: [{ type: 'text', text: 'plain' }] }));
        const response = await transport.handleMessage(toolsCall());
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(response.headers.get('x-accel-buffering')).toBeNull();
        const body = (await response.json()) as { result: { content: Array<{ text: string }> } };
        expect(body.result.content[0]?.text).toBe('plain');
    });

    it('upgrades to SSE on the first related notification', async () => {
        const { transport } = await setup(async ctx => {
            await ctx.mcpReq.notify(progressNotification(1));
            return { content: [{ type: 'text', text: 'streamed' }] };
        });
        const response = await transport.handleMessage(toolsCall());
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/event-stream');
        expect(response.headers.get('cache-control')).toBe('no-cache');
        expect(response.headers.get('x-accel-buffering')).toBe('no');

        const frames = await sseFrames(response);
        expect(frames).toHaveLength(2);
        expect(dataOf(frames[0]!)).toMatchObject({ method: 'notifications/progress' });
        expect(dataOf(frames[1]!)).toMatchObject({ id: 1, result: { content: [{ type: 'text', text: 'streamed' }] } });
    });

    it('drains every streamed message before the terminal result and then ends the stream', async () => {
        const { transport } = await setup(async ctx => {
            await ctx.mcpReq.notify(progressNotification(1));
            await ctx.mcpReq.notify(progressNotification(2));
            await ctx.mcpReq.notify(progressNotification(3));
            return { content: [{ type: 'text', text: 'done' }] };
        });
        const response = await transport.handleMessage(toolsCall());
        const frames = await sseFrames(response);
        expect(frames).toHaveLength(4);
        const progressValues = frames.slice(0, 3).map(frame => (dataOf(frame) as { params: { progress: number } }).params.progress);
        expect(progressValues).toEqual([1, 2, 3]);
        expect(dataOf(frames[3]!)).toMatchObject({ result: { content: [{ type: 'text', text: 'done' }] } });
    });

    it('emits no resumability bytes: no event ids, no retry hints, no priming events', async () => {
        const { transport } = await setup(async ctx => {
            await ctx.mcpReq.notify(progressNotification(1));
            return { content: [] };
        });
        const response = await transport.handleMessage(toolsCall());
        const text = await response.text();
        expect(text).not.toMatch(/^id:/m);
        expect(text).not.toMatch(/^retry:/m);
        expect(response.headers.get('mcp-session-id')).toBeNull();
    });

    it('drops writes after the exchange is closed', async () => {
        // A streamed exchange whose stream has already been finalized: a late
        // related write must be dropped by the closed-guard. If that guard
        // were removed, the write would hit the closed stream controller and
        // be reported through onerror.
        const { transport } = await setup(async ctx => {
            await ctx.mcpReq.notify(progressNotification(1));
            return { content: [] };
        });
        const response = await transport.handleMessage(toolsCall());
        await response.text();
        await transport.close();
        const errors: Error[] = [];
        transport.onerror = error => errors.push(error);
        await expect(transport.send(progressNotification(9) as never, { relatedRequestId: 1 })).resolves.toBeUndefined();
        expect(errors).toHaveLength(0);
    });
});

describe('forced response modes (the seam the entry-level knob plugs into)', () => {
    it('sse mode opens the stream immediately, even with no streamed output', async () => {
        const { transport } = await setup(async () => ({ content: [{ type: 'text', text: 'eager' }] }), 'sse');
        const response = await transport.handleMessage(toolsCall());
        expect(response.headers.get('content-type')).toBe('text/event-stream');
        const frames = await sseFrames(response);
        expect(frames).toHaveLength(1);
        expect(dataOf(frames[0]!)).toMatchObject({ result: { content: [{ type: 'text', text: 'eager' }] } });
    });

    it('sse mode still answers pre-dispatch rejections with their mapped HTTP status', async () => {
        // The forced-sse stream opens only after the pre-dispatch gates pass:
        // a request the validation ladder rejects (here: an unknown method
        // with no handler) keeps the spec-mandated HTTP status instead of
        // being framed onto a 200 stream.
        const { transport } = await setup(async () => ({ content: [] }), 'sse');
        const unknownMethod = {
            jsonrpc: '2.0',
            id: 1,
            method: 'definitely/unknown',
            params: { _meta: ENVELOPE }
        } as JSONRPCRequest;
        const response = await transport.handleMessage(unknownMethod);
        expect(response.status).toBe(404);
        expect(response.headers.get('content-type')).toContain('application/json');
        const body = (await response.json()) as { error?: { code: number } };
        expect(body.error?.code).toBe(-32_601);
    });

    it('json mode never upgrades and drops mid-call notifications', async () => {
        const { transport } = await setup(async ctx => {
            await ctx.mcpReq.notify(progressNotification(1));
            await ctx.mcpReq.notify(progressNotification(2));
            return { content: [{ type: 'text', text: 'json-only' }] };
        }, 'json');
        const response = await transport.handleMessage(toolsCall());
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('application/json');
        const body = (await response.json()) as { result: { content: Array<{ text: string }> } };
        expect(body.result.content[0]?.text).toBe('json-only');
        // The notifications were dropped, not buffered into the body.
        expect(JSON.stringify(body)).not.toContain('notifications/progress');
    });
});

describe('comment frames', () => {
    it('writes comment frames into an open stream and drops them otherwise', async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const { transport } = await setup(async () => {
            await gate;
            return { content: [] };
        }, 'sse');

        const responsePromise = transport.handleMessage(toolsCall());
        // The stream is open (sse mode settles once the pre-dispatch gates
        // pass); a comment frame written now must be delivered to the
        // consumer.
        transport.writeCommentFrame('keep-alive');
        release();
        const response = await responsePromise;
        const text = await response.text();
        expect(text).toContain(': keep-alive');

        // After the exchange completed (and the transport closed itself),
        // comment frames are dropped silently — and never surface as stream
        // write errors, which is what would happen without the closed-guard.
        const errors: Error[] = [];
        transport.onerror = error => errors.push(error);
        transport.writeCommentFrame('late');
        expect(errors).toHaveLength(0);
    });
});

describe('disconnect is cancellation', () => {
    it('cancelling the SSE stream aborts the in-flight handler', async () => {
        let observedSignal: AbortSignal | undefined;
        let abortObserved!: () => void;
        const aborted = new Promise<void>(resolve => {
            abortObserved = resolve;
        });
        const { transport } = await setup(async ctx => {
            observedSignal = ctx.mcpReq.signal;
            ctx.mcpReq.signal.addEventListener('abort', () => abortObserved(), { once: true });
            await ctx.mcpReq.notify(progressNotification(1));
            await aborted;
            return { content: [] };
        });
        const response = await transport.handleMessage(toolsCall());
        expect(response.headers.get('content-type')).toBe('text/event-stream');

        const reader = response.body!.getReader();
        await reader.read();
        // The client goes away: cancelling the response stream tears the
        // exchange down and aborts the handler's signal.
        await reader.cancel();
        await aborted;
        expect(observedSignal?.aborted).toBe(true);
    });
});
