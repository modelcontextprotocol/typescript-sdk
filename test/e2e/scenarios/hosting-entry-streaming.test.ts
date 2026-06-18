/**
 * Modern-era (2026-07-28) response streaming through the dual-era HTTP entry,
 * exercised on the wire() entryModern arm:
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
 * Every body drives the harness-hosted entry through the wired client (the
 * entryModern arm pins it to 2026-07-28); the typed result and the raw wire
 * bytes (status, content-type, SSE frames)
 * are asserted side by side via the arm-recorded `wired.httpLog`.
 */
import { Client } from '@modelcontextprotocol/client';
import type { CallToolResult, McpRequestContext } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import { expect } from 'vitest';
import { z } from 'zod/v4';

import type { Wired } from '../helpers/index.js';
import { wire } from '../helpers/index.js';
import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

const MODERN = '2026-07-28';

/**
 * One factory with a quiet tool (no streamed output) and a chatty tool (two
 * logging notifications emitted before its result), so the lazy upgrade and
 * both forced response modes are observable per call.
 */
function streamingFactory(_ctx?: McpRequestContext): McpServer {
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

interface RecordedResponse {
    status: number;
    contentType: string;
    body: string;
}

/** Every recorded HTTP response (status, content-type, raw body bytes), in exchange order. */
function recordedResponses(wired: Wired): Promise<RecordedResponse[]> {
    return Promise.all(
        (wired.httpLog ?? []).map(async exchange => ({
            status: exchange.status,
            contentType: exchange.contentType,
            body: await exchange.response.text()
        }))
    );
}

/** The `data:` payloads of an SSE-framed body, parsed, in frame order. */
function sseDataFrames(body: string): Array<Record<string, unknown>> {
    return body
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
}

function newClient(): Client {
    return new Client({ name: 'e2e-streaming-client', version: '1.0.0' });
}

function callTool(client: Client, name: 'quiet' | 'chatty'): Promise<CallToolResult> {
    return client.callTool({ name, arguments: {} }) as Promise<CallToolResult>;
}

verifies('typescript:hosting:entry:modern-lazy-sse-upgrade', async ({ transport }: TestArgs) => {
    const client = newClient();
    await using wired = await wire(transport, streamingFactory, client);
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);

    // Quiet handler: nothing emitted before the result → a single JSON body.
    const quiet = await callTool(client, 'quiet');
    expect(quiet.content).toEqual([{ type: 'text', text: 'quiet result' }]);

    // Chatty handler: the first related notification upgrades the exchange
    // to SSE — notifications framed in order, terminal result last.
    const chatty = await callTool(client, 'chatty');
    expect(chatty.content).toEqual([{ type: 'text', text: 'chatty result' }]);

    const responses = await recordedResponses(wired);
    const quietResponse = responses.find(response => response.body.includes('quiet result'));
    expect(quietResponse).toBeDefined();
    expect(quietResponse!.status).toBe(200);
    expect(quietResponse!.contentType).toContain('application/json');

    const chattyResponse = responses.find(response => response.body.includes('chatty result'));
    expect(chattyResponse).toBeDefined();
    expect(chattyResponse!.status).toBe(200);
    expect(chattyResponse!.contentType).toContain('text/event-stream');

    const frames = sseDataFrames(chattyResponse!.body);
    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({ method: 'notifications/message', params: { data: 'first' } });
    expect(frames[1]).toMatchObject({ method: 'notifications/message', params: { data: 'second' } });
    expect(frames[2]).toMatchObject({ result: { content: [{ type: 'text', text: 'chatty result' }] } });
});

verifies('typescript:hosting:entry:modern-response-mode', async ({ transport }: TestArgs) => {
    // One harness-hosted endpoint per responseMode value, both backed by the same factory.

    // responseMode 'sse': even a handler that emits nothing streams its result.
    {
        const client = newClient();
        await using wired = await wire(transport, streamingFactory, client, { entry: { responseMode: 'sse' } });
        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);

        const result = await callTool(client, 'quiet');
        expect(result.content).toEqual([{ type: 'text', text: 'quiet result' }]);

        const responses = await recordedResponses(wired);
        const response = responses.find(candidate => candidate.body.includes('quiet result'));
        expect(response).toBeDefined();
        expect(response!.status).toBe(200);
        expect(response!.contentType).toContain('text/event-stream');
        const frames = sseDataFrames(response!.body);
        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({ result: { content: [{ type: 'text', text: 'quiet result' }] } });
    }

    // responseMode 'json': mid-call notifications are dropped — the response
    // is a plain JSON body whose only payload is the terminal result.
    {
        const client = newClient();
        await using wired = await wire(transport, streamingFactory, client, { entry: { responseMode: 'json' } });
        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);

        const result = await callTool(client, 'chatty');
        expect(result.content).toEqual([{ type: 'text', text: 'chatty result' }]);

        const responses = await recordedResponses(wired);
        const response = responses.find(candidate => candidate.body.includes('chatty result'));
        expect(response).toBeDefined();
        expect(response!.status).toBe(200);
        expect(response!.contentType).toContain('application/json');
        expect(response!.body).not.toContain('notifications/message');
    }
});
