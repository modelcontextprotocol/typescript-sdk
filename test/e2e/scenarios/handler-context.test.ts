/**
 * Self-contained test bodies for the ServerContext conveniences handed to
 * request handlers: `ctx.mcpReq.log()`, `ctx.mcpReq.elicitInput()`,
 * `ctx.mcpReq.requestSampling()`, and — under HTTP hosting — `ctx.http.req`
 * exposing the incoming request's Fetch Headers.
 *
 * Each body builds its own server (via factory) and client, wires them with
 * {@link wire} (or hosts directly with {@link hostPerSession} where the HTTP
 * hosting layer is itself the subject), and asserts.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CreateMessageRequest, ElicitRequest, ElicitRequestFormParams, LoggingLevel } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { hostPerSession, wire } from '../helpers/index';
import { verifies } from '../helpers/verifies';
import type { TestArgs } from '../types';

verifies('mcpserver:context:log-from-handler', async ({ transport }: TestArgs) => {
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>(resolve => {
        releaseHandler = resolve;
    });

    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' }, { capabilities: { logging: {} } });
        s.registerTool('emit-log', { inputSchema: z.object({}) }, async (_args, ctx) => {
            await ctx.mcpReq.log('info', { msg: 'from-handler' }, 'handler-logger');
            // Hold the tool call open until the test has observed the notification, so receipt provably happens mid-call.
            await handlerGate;
            return { content: [{ type: 'text', text: 'done' }] };
        });
        return s;
    };

    const logs: Array<{ level: LoggingLevel; logger?: string; data: unknown }> = [];
    const client = new Client({ name: 'c', version: '0' });
    client.setNotificationHandler('notifications/message', n => {
        logs.push(n.params);
    });

    await using _ = await wire(transport, makeServer, client);

    // On a 2026-era request the spec says an absent `_meta.logLevel` envelope key means the server MUST NOT
    // send notifications/message — so the entryModern arm needs the key set explicitly for the log to be
    // emitted. Legacy-era arms ignore the key (the session-scoped level applies; absent → no filter).
    const inFlightCall = client.callTool({ name: 'emit-log', arguments: {}, _meta: { 'io.modelcontextprotocol/logLevel': 'debug' } });
    try {
        // The handler is parked on the gate, so the tools/call request is still in flight when the log arrives.
        await vi.waitFor(() => expect(logs).toHaveLength(1));
        expect(logs).toEqual([{ level: 'info', logger: 'handler-logger', data: { msg: 'from-handler' } }]);
    } finally {
        releaseHandler();
    }

    const result = await inFlightCall;
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
});

verifies('mcpserver:context:elicit-from-handler', async ({ transport }: TestArgs) => {
    const requestedSchema: ElicitRequestFormParams['requestedSchema'] = {
        type: 'object',
        properties: { color: { type: 'string' } },
        required: ['color']
    };

    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('ask-color', { inputSchema: z.object({}) }, async (_args, ctx) => {
            const ans = await ctx.mcpReq.elicitInput({ mode: 'form', message: 'Favorite color?', requestedSchema });
            const color = ans.action === 'accept' ? String(ans.content?.color) : '<none>';
            return { content: [{ type: 'text', text: `${ans.action}:${color}` }] };
        });
        return s;
    };

    const received: ElicitRequest['params'][] = [];
    const client = new Client({ name: 'c', version: '0' }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler('elicitation/create', async req => {
        received.push(req.params);
        return { action: 'accept', content: { color: 'teal' } };
    });

    await using _ = await wire(transport, makeServer, client);

    const result = await client.callTool({ name: 'ask-color', arguments: {} });

    expect(received).toEqual([{ mode: 'form', message: 'Favorite color?', requestedSchema }]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'accept:teal' }]);
});

verifies('mcpserver:context:sampling-from-handler', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('summarize', { inputSchema: z.object({ topic: z.string() }) }, async ({ topic }, ctx) => {
            const result = await ctx.mcpReq.requestSampling({
                messages: [{ role: 'user', content: { type: 'text', text: `Summarize ${topic}` } }],
                maxTokens: 50
            });
            // Without tools in the request the stub client returns a single text block; arrays would mean a tool-use flow.
            const text = !Array.isArray(result.content) && result.content.type === 'text' ? result.content.text : '<unexpected>';
            return { content: [{ type: 'text', text: `${result.model}|${result.role}|${text}` }] };
        });
        return s;
    };

    const received: CreateMessageRequest[] = [];
    const client = new Client({ name: 'c', version: '0' }, { capabilities: { sampling: {} } });
    client.setRequestHandler('sampling/createMessage', async req => {
        received.push(req);
        return { model: 'stub-model', role: 'assistant', stopReason: 'endTurn', content: { type: 'text', text: 'a short summary' } };
    });

    await using _ = await wire(transport, makeServer, client);

    const result = await client.callTool({ name: 'summarize', arguments: { topic: 'mcp' } });

    expect(received).toHaveLength(1);
    const samplingRequest = received[0];
    if (samplingRequest === undefined) throw new Error('expected exactly one sampling request');
    expect(samplingRequest.method).toBe('sampling/createMessage');
    expect(samplingRequest.params.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'Summarize mcp' } }]);
    expect(samplingRequest.params.maxTokens).toBe(50);

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'stub-model|assistant|a short summary' }]);
});

verifies('hosting:context:web-request-headers', async (_args: TestArgs) => {
    const PROBE_HEADER = 'x-e2e-probe';
    const PROBE_VALUE = 'probe-7d1f';

    const seenByTool: Array<{ isFetchHeaders: boolean; probe: string | null }> = [];
    const mcpHost = hostPerSession(() => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('read-probe-header', { inputSchema: z.object({}) }, (_toolArgs, ctx) => {
            const headers = ctx.http?.req?.headers;
            seenByTool.push({
                isFetchHeaders: headers instanceof Headers,
                probe: headers instanceof Headers ? headers.get(PROBE_HEADER) : null
            });
            return { content: [{ type: 'text', text: headers?.get(PROBE_HEADER) ?? '<missing>' }] };
        });
        return s;
    });

    const client = new Client({ name: 'c', version: '0' });
    const httpTransport = new StreamableHTTPClientTransport(new URL('http://in-process/mcp'), {
        fetch: (url, init) => mcpHost.handleRequest(new Request(url, init)),
        requestInit: { headers: { [PROBE_HEADER]: PROBE_VALUE } }
    });

    try {
        await client.connect(httpTransport);
        const result = await client.callTool({ name: 'read-probe-header', arguments: {} });

        // The custom header set on the client transport is readable as Fetch Headers inside the handler.
        expect(seenByTool).toEqual([{ isFetchHeaders: true, probe: PROBE_VALUE }]);
        expect(result.isError).toBeFalsy();
        expect(result.content).toEqual([{ type: 'text', text: PROBE_VALUE }]);
    } finally {
        await client.close();
        await mcpHost.close();
    }
});
