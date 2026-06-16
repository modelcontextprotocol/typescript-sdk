/**
 * Modern-era (2026-07-28) response streaming through the dual-era HTTP entry,
 * observed on a real socket:
 *
 * - default response mode: a handler that emits nothing before its result is
 *   answered as a single JSON body; a handler that emits related notifications
 *   mid-call upgrades the response to an SSE stream (content-type
 *   text/event-stream, notifications framed in emission order, terminal result
 *   last);
 * - `responseMode: 'sse'` always streams, even with no mid-call output;
 * - `responseMode: 'json'` never streams and drops mid-call notifications —
 *   only the terminal result is delivered.
 *
 * Every body hosts the handler's node face on a real node:http listener and
 * drives it with the auto-negotiating client over a recording fetch, so the
 * typed result and the raw wire bytes are asserted side by side. Like
 * hosting-entry.test.ts these bodies do not use `wire()`.
 */
import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:http';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/core';
import type { CallToolResult, CreateMcpHandlerOptions, McpHttpHandler, McpRequestContext } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { listenOnRandomPort } from '@modelcontextprotocol/test-helpers';
import { expect } from 'vitest';
import { z } from 'zod/v4';

import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

const MODERN = '2026-07-28';

/** The per-request `_meta` envelope every 2026-era request carries (attached explicitly until automatic emission lands client-side). */
function modernEnvelope() {
    return {
        [PROTOCOL_VERSION_META_KEY]: MODERN,
        [CLIENT_INFO_META_KEY]: { name: 'e2e-streaming-client', version: '1.0.0' },
        [CLIENT_CAPABILITIES_META_KEY]: {}
    };
}

/**
 * One factory with a quiet tool (no streamed output) and a chatty tool (two
 * logging notifications emitted before its result), so the lazy upgrade and
 * both forced response modes are observable per call.
 */
function streamingFactory(_ctx: McpRequestContext): McpServer {
    const server = new McpServer({ name: 'e2e-entry-streaming', version: '1.0.0' }, { capabilities: { tools: {}, logging: {} } });
    server.registerTool('quiet', { inputSchema: z.object({}) }, () => ({
        content: [{ type: 'text', text: 'quiet result' }]
    }));
    server.registerTool('chatty', { inputSchema: z.object({}) }, async (_args, ctx) => {
        await ctx.mcpReq.notify({ method: 'notifications/message', params: { level: 'info', data: 'first' } });
        await ctx.mcpReq.notify({ method: 'notifications/message', params: { level: 'info', data: 'second' } });
        return { content: [{ type: 'text', text: 'chatty result' }] };
    });
    return server;
}

interface Endpoint extends AsyncDisposable {
    baseUrl: URL;
    handler: McpHttpHandler;
}

/** Hosts the handler's node face on a real node:http listener bound to an ephemeral port. */
async function startEndpoint(options?: CreateMcpHandlerOptions): Promise<Endpoint> {
    const handler = createMcpHandler(streamingFactory, options);
    const httpServer: HttpServer = createServer((req, res) => void handler.node(req, res));
    const baseUrl = await listenOnRandomPort(httpServer);
    return {
        baseUrl,
        handler,
        [Symbol.asyncDispose]: async () => {
            await handler.close();
            await new Promise<void>((resolve, reject) => httpServer.close(error => (error ? reject(error) : resolve())));
        }
    };
}

interface RecordedResponse {
    status: number;
    contentType: string;
    body: string;
}

/** Records every HTTP response (status, content-type, raw body bytes) the client receives. */
function recordingFetch(responses: RecordedResponse[]): typeof fetch {
    return async (input, init) => {
        const response = await fetch(input, init);
        responses.push({
            status: response.status,
            contentType: response.headers.get('content-type') ?? '',
            body: await response.clone().text()
        });
        return response;
    };
}

/** The `data:` payloads of an SSE-framed body, parsed, in frame order. */
function sseDataFrames(body: string): Array<Record<string, unknown>> {
    return body
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
}

async function connectAutoClient(baseUrl: URL, responses: RecordedResponse[]): Promise<Client> {
    const client = new Client({ name: 'e2e-streaming-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(baseUrl, { fetch: recordingFetch(responses) }));
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
    return client;
}

function callTool(client: Client, name: 'quiet' | 'chatty'): Promise<CallToolResult> {
    return client.request({
        method: 'tools/call',
        params: { name, arguments: {}, _meta: modernEnvelope() }
    }) as Promise<CallToolResult>;
}

verifies('typescript:hosting:entry:modern-lazy-sse-upgrade', async (_args: TestArgs) => {
    await using endpoint = await startEndpoint();

    const responses: RecordedResponse[] = [];
    const client = await connectAutoClient(endpoint.baseUrl, responses);
    try {
        // Quiet handler: nothing emitted before the result → a single JSON body.
        const quiet = await callTool(client, 'quiet');
        expect(quiet.content).toEqual([{ type: 'text', text: 'quiet result' }]);
        const quietResponse = responses.find(response => response.body.includes('quiet result'));
        expect(quietResponse).toBeDefined();
        expect(quietResponse!.status).toBe(200);
        expect(quietResponse!.contentType).toContain('application/json');

        // Chatty handler: the first related notification upgrades the exchange
        // to SSE — notifications framed in order, terminal result last.
        const chatty = await callTool(client, 'chatty');
        expect(chatty.content).toEqual([{ type: 'text', text: 'chatty result' }]);
        const chattyResponse = responses.find(response => response.body.includes('chatty result'));
        expect(chattyResponse).toBeDefined();
        expect(chattyResponse!.status).toBe(200);
        expect(chattyResponse!.contentType).toContain('text/event-stream');

        const frames = sseDataFrames(chattyResponse!.body);
        expect(frames).toHaveLength(3);
        expect(frames[0]).toMatchObject({ method: 'notifications/message', params: { data: 'first' } });
        expect(frames[1]).toMatchObject({ method: 'notifications/message', params: { data: 'second' } });
        expect(frames[2]).toMatchObject({ result: { content: [{ type: 'text', text: 'chatty result' }] } });
    } finally {
        await client.close();
    }
});

verifies('typescript:hosting:entry:modern-response-mode', async (_args: TestArgs) => {
    // One endpoint per responseMode value, both backed by the same factory.
    await using sseEndpoint = await startEndpoint({ responseMode: 'sse' });
    await using jsonEndpoint = await startEndpoint({ responseMode: 'json' });

    // responseMode 'sse': even a handler that emits nothing streams its result.
    {
        const responses: RecordedResponse[] = [];
        const client = await connectAutoClient(sseEndpoint.baseUrl, responses);
        try {
            const result = await callTool(client, 'quiet');
            expect(result.content).toEqual([{ type: 'text', text: 'quiet result' }]);
            const response = responses.find(candidate => candidate.body.includes('quiet result'));
            expect(response).toBeDefined();
            expect(response!.status).toBe(200);
            expect(response!.contentType).toContain('text/event-stream');
            const frames = sseDataFrames(response!.body);
            expect(frames).toHaveLength(1);
            expect(frames[0]).toMatchObject({ result: { content: [{ type: 'text', text: 'quiet result' }] } });
        } finally {
            await client.close();
        }
    }

    // responseMode 'json': mid-call notifications are dropped — the response
    // is a plain JSON body whose only payload is the terminal result.
    {
        const responses: RecordedResponse[] = [];
        const client = await connectAutoClient(jsonEndpoint.baseUrl, responses);
        try {
            const result = await callTool(client, 'chatty');
            expect(result.content).toEqual([{ type: 'text', text: 'chatty result' }]);
            const response = responses.find(candidate => candidate.body.includes('chatty result'));
            expect(response).toBeDefined();
            expect(response!.status).toBe(200);
            expect(response!.contentType).toContain('application/json');
            expect(response!.body).not.toContain('notifications/message');
        } finally {
            await client.close();
        }
    }
});
