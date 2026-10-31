import type { ClientOptions } from '@modelcontextprotocol/client';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { context, propagation, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { registerTestSdk } from './sdk';

// The application's OpenTelemetry SDK. Client and McpServer need nothing else.
const sdk = registerTestSdk();
beforeEach(() => sdk.reset());
afterAll(() => sdk.unregister());

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
});

/** A client and server over in-memory transports, with no telemetry configuration at all. */
async function connect(buildServer: (server: McpServer) => void, clientOptions: ClientOptions = {}) {
    const server = new McpServer({ name: 'weather', version: '1.0.0' });
    buildServer(server);
    const client = new Client({ name: 'agent', version: '1.0.0' }, clientOptions);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    cleanups.push(() => client.close());
    return { client, server };
}

function registerGreet(server: McpServer) {
    server.registerTool('greet', { inputSchema: z.object({ name: z.string() }) }, ({ name }) => ({
        content: [{ type: 'text', text: `hello ${name}` }],
        structuredContent: { greeting: `hello ${name}` }
    }));
}

describe('OpenTelemetry spans', () => {
    it('emits a CLIENT span and a SERVER child span for a tool call, named after the tool', async () => {
        const { client } = await connect(registerGreet);

        await client.callTool({ name: 'greet', arguments: { name: 'Ada' } });

        const clientSpan = sdk.span('tools/call greet', SpanKind.CLIENT);
        const serverSpan = sdk.span('tools/call greet', SpanKind.SERVER);
        expect(serverSpan.spanContext().traceId).toBe(clientSpan.spanContext().traceId);
        expect(serverSpan.parentSpanContext?.spanId).toBe(clientSpan.spanContext().spanId);
        expect(clientSpan.instrumentationScope.name).toBe('@modelcontextprotocol/client');
        expect(serverSpan.instrumentationScope.name).toBe('@modelcontextprotocol/server');
        expect({ ...clientSpan.attributes }).toEqual({
            'mcp.method.name': 'tools/call',
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': 'greet',
            'jsonrpc.request.id': expect.any(String),
            'mcp.protocol.version': '2025-11-25'
        });
        expect({ ...serverSpan.attributes }).toMatchObject({
            'mcp.method.name': 'tools/call',
            'gen_ai.tool.name': 'greet',
            'jsonrpc.request.id': clientSpan.attributes['jsonrpc.request.id']
        });
        expect(clientSpan.status.code).toBe(SpanStatusCode.UNSET);
        expect(serverSpan.status.code).toBe(SpanStatusCode.UNSET);
    });

    it('parents the client span on the active span and makes the server span active inside the tool', async () => {
        const { client } = await connect(server => {
            server.registerTool('lookup', { inputSchema: z.object({}) }, async () => {
                await sdk.tracer.startActiveSpan('db.query', async span => span.end());
                return { content: [] };
            });
        });

        await sdk.tracer.startActiveSpan('invoke_agent', async agent => {
            await client.callTool({ name: 'lookup', arguments: {} });
            agent.end();
        });

        const agent = sdk.span('invoke_agent', SpanKind.INTERNAL);
        const clientSpan = sdk.span('tools/call lookup', SpanKind.CLIENT);
        const serverSpan = sdk.span('tools/call lookup', SpanKind.SERVER);
        const dbSpan = sdk.span('db.query', SpanKind.INTERNAL);
        expect(clientSpan.parentSpanContext?.spanId).toBe(agent.spanContext().spanId);
        expect(serverSpan.parentSpanContext?.spanId).toBe(clientSpan.spanContext().spanId);
        expect(dbSpan.parentSpanContext?.spanId).toBe(serverSpan.spanContext().spanId);
    });

    it('traces the handshake and notifications, and skips log notifications', async () => {
        const { client } = await connect(server => {
            server.server.registerCapabilities({ logging: {} });
            server.registerTool('noisy', { inputSchema: z.object({}) }, async (_args, ctx) => {
                await ctx.mcpReq.log('info', 'working');
                return { content: [] };
            });
        });
        await client.setLoggingLevel('info');

        await client.callTool({ name: 'noisy', arguments: {} });

        expect(sdk.span('initialize', SpanKind.CLIENT).attributes['mcp.protocol.version']).toBe('2025-11-25');
        expect(sdk.span('initialize', SpanKind.SERVER)).toBeDefined();
        expect(sdk.span('notifications/initialized', SpanKind.CLIENT).attributes['jsonrpc.request.id']).toBeUndefined();
        expect(sdk.span('notifications/initialized', SpanKind.SERVER)).toBeDefined();
        expect(sdk.spans().filter(s => s.name === 'notifications/message')).toEqual([]);
    });

    it('marks a tool result with isError as tool_error on both sides', async () => {
        const { client } = await connect(server => {
            server.registerTool('fail', { inputSchema: z.object({}) }, () => ({
                content: [{ type: 'text', text: 'secret detail' }],
                isError: true
            }));
        });

        await client.callTool({ name: 'fail', arguments: {} });

        for (const kind of [SpanKind.CLIENT, SpanKind.SERVER]) {
            const span = sdk.span('tools/call fail', kind);
            expect(span.attributes['error.type']).toBe('tool_error');
            expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
        }
    });

    it('treats an unknown tool as a caller error: an error on the client, not on the server, and no tool name in the server span name', async () => {
        const { client } = await connect(registerGreet);

        await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toThrow(/not found/);

        const clientSpan = sdk.span('tools/call nope', SpanKind.CLIENT);
        expect(clientSpan.attributes).toMatchObject({ 'error.type': '-32602', 'rpc.response.status_code': '-32602' });
        expect(clientSpan.status.code).toBe(SpanStatusCode.ERROR);
        const serverSpan = sdk.span('tools/call', SpanKind.SERVER);
        expect(serverSpan.attributes['rpc.response.status_code']).toBe('-32602');
        expect(serverSpan.attributes['error.type']).toBeUndefined();
        expect(serverSpan.status.code).toBe(SpanStatusCode.UNSET);
    });

    it('records an exception event when a handler throws something other than a protocol error', async () => {
        const { client } = await connect(server => {
            server.server.setRequestHandler('acme/boom', { params: z.object({}) }, () => {
                throw new Error('database unreachable');
            });
            server.server.setRequestHandler('acme/refuse', { params: z.object({}) }, () => {
                throw new ProtocolError(-32_001, 'quota exceeded');
            });
        });

        await expect(client.request({ method: 'acme/boom', params: {} }, z.object({}))).rejects.toThrow('database unreachable');
        await expect(client.request({ method: 'acme/refuse', params: {} }, z.object({}))).rejects.toThrow('quota exceeded');

        const boom = sdk.span('acme/boom', SpanKind.SERVER);
        expect(boom.attributes['error.type']).toBe(String(ProtocolErrorCode.InternalError));
        expect(boom.status).toEqual({ code: SpanStatusCode.ERROR, message: 'database unreachable' });
        expect(boom.events.map(e => [e.name, e.attributes?.['exception.message']])).toEqual([['exception', 'database unreachable']]);
        const refuse = sdk.span('acme/refuse', SpanKind.SERVER);
        expect(refuse.attributes['error.type']).toBe('-32001');
        expect(refuse.events).toEqual([]);
    });

    it('records a method the server does not handle as _OTHER', async () => {
        const { client } = await connect(registerGreet);

        await expect(client.request({ method: 'attacker/chosen-name', params: {} }, z.object({}))).rejects.toThrow();

        const serverSpan = sdk.span('_OTHER', SpanKind.SERVER);
        expect(serverSpan.attributes['mcp.method.name']).toBe('_OTHER');
        expect(serverSpan.attributes['rpc.response.status_code']).toBe('-32601');
        expect(sdk.span('attacker/chosen-name', SpanKind.CLIENT).attributes['error.type']).toBe('-32601');
    });

    it('names prompt spans after the prompt and records resource URIs on resource spans', async () => {
        const { client } = await connect(server => {
            server.registerPrompt('review', { argsSchema: z.object({ language: z.string() }) }, ({ language }) => ({
                messages: [{ role: 'user', content: { type: 'text', text: `review this ${language}` } }]
            }));
            server.registerResource('readme', 'file:///readme.md', {}, uri => ({ contents: [{ uri: uri.href, text: '# hi' }] }));
        });

        await client.getPrompt({ name: 'review', arguments: { language: 'TypeScript' } });
        await client.readResource({ uri: 'file:///readme.md' });

        expect(sdk.span('prompts/get review', SpanKind.CLIENT).attributes['gen_ai.prompt.name']).toBe('review');
        expect(sdk.span('prompts/get review', SpanKind.SERVER).attributes['gen_ai.prompt.variable.language']).toBeUndefined();
        expect(sdk.span('resources/read', SpanKind.SERVER).attributes['mcp.resource.uri']).toBe('file:///readme.md');
    });

    it('records no tool arguments, tool results or prompt arguments by default', async () => {
        const { client } = await connect(registerGreet);

        await client.callTool({ name: 'greet', arguments: { name: 'Ada' } });

        const recorded = JSON.stringify(sdk.spans().map(s => s.attributes));
        expect(recorded).not.toContain('Ada');
        expect(recorded).not.toContain('gen_ai.tool.call');
    });

    it('follows a 2025-era elicitation from inside a tool back to the client', async () => {
        const { client } = await connect(
            server => {
                server.registerTool('confirm', { inputSchema: z.object({}) }, async (_args, ctx) => {
                    const answer = await ctx.mcpReq.elicitInput({
                        mode: 'form',
                        message: 'Proceed?',
                        requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } } }
                    });
                    return { content: [{ type: 'text', text: answer.action }] };
                });
            },
            { capabilities: { elicitation: {} } }
        );
        client.setRequestHandler('elicitation/create', () => ({ action: 'accept', content: { ok: true } }));

        await client.callTool({ name: 'confirm', arguments: {} });

        const toolSpan = sdk.span('tools/call confirm', SpanKind.SERVER);
        const askSpan = sdk.span('elicitation/create', SpanKind.CLIENT);
        const answerSpan = sdk.span('elicitation/create', SpanKind.SERVER);
        expect(askSpan.parentSpanContext?.spanId).toBe(toolSpan.spanContext().spanId);
        expect(answerSpan.parentSpanContext?.spanId).toBe(askSpan.spanContext().spanId);
    });

    it('ends a timed-out request with error.type timeout', async () => {
        const { client } = await connect(server => {
            server.registerTool('slow', { inputSchema: z.object({}) }, () => new Promise<never>(() => {}));
        });

        await expect(client.callTool({ name: 'slow', arguments: {} }, { timeout: 20 })).rejects.toThrow(/timed out/);

        const span = sdk.span('tools/call slow', SpanKind.CLIENT);
        expect(span.attributes['error.type']).toBe('timeout');
        expect(span.status.code).toBe(SpanStatusCode.ERROR);
        expect(sdk.span('notifications/cancelled', SpanKind.CLIENT)).toBeDefined();
    });

    it('parents the client span on trace context the caller put in _meta', async () => {
        const { client } = await connect(registerGreet);
        const upstream = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

        await client.callTool({ name: 'greet', arguments: { name: 'Ada' }, _meta: { traceparent: upstream } });

        const clientSpan = sdk.span('tools/call greet', SpanKind.CLIENT);
        expect(clientSpan.spanContext().traceId).toBe('0af7651916cd43dd8448eb211c80319c');
        expect(clientSpan.parentSpanContext?.spanId).toBe('b7ad6b7169203331');
        expect(sdk.span('tools/call greet', SpanKind.SERVER).parentSpanContext?.spanId).toBe(clientSpan.spanContext().spanId);
    });

    it('propagates baggage through _meta', async () => {
        let baggageInTool: string | undefined;
        const { client } = await connect(server => {
            server.registerTool('whoami', { inputSchema: z.object({}) }, () => {
                baggageInTool = propagation.getActiveBaggage()?.getEntry('tenant')?.value;
                return { content: [] };
            });
        });

        const withBaggage = propagation.setBaggage(context.active(), propagation.createBaggage({ tenant: { value: 'acme' } }));
        await context.with(withBaggage, () => client.callTool({ name: 'whoami', arguments: {} }));

        expect(baggageInTool).toBe('acme');
    });
});

describe('OpenTelemetry metrics', () => {
    it('records operation durations with the semconv unit, buckets and low-cardinality attributes', async () => {
        const { client } = await connect(server => {
            registerGreet(server);
            server.registerResource('readme', 'file:///readme.md', {}, uri => ({ contents: [{ uri: uri.href, text: '# hi' }] }));
        });

        await client.callTool({ name: 'greet', arguments: { name: 'Ada' } });
        await client.readResource({ uri: 'file:///readme.md' });
        await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toThrow();

        const clientDuration = await sdk.histogram('mcp.client.operation.duration');
        expect(clientDuration.unit).toBe('s');
        expect(clientDuration.boundaries).toEqual([0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300]);
        expect(clientDuration.points.map(p => p.attributes)).toEqual(
            expect.arrayContaining([
                {
                    'mcp.method.name': 'tools/call',
                    'gen_ai.operation.name': 'execute_tool',
                    'gen_ai.tool.name': 'greet',
                    'mcp.protocol.version': '2025-11-25'
                },
                { 'mcp.method.name': 'resources/read', 'mcp.protocol.version': '2025-11-25' },
                {
                    'mcp.method.name': 'tools/call',
                    'gen_ai.operation.name': 'execute_tool',
                    'gen_ai.tool.name': 'nope',
                    'mcp.protocol.version': '2025-11-25',
                    'error.type': '-32602',
                    'rpc.response.status_code': '-32602'
                }
            ])
        );

        const serverDuration = await sdk.histogram('mcp.server.operation.duration');
        const serverToolCalls = serverDuration.points.filter(p => p.attributes['mcp.method.name'] === 'tools/call').map(p => p.attributes);
        // The rejected tool name stays out of server metrics.
        expect(serverToolCalls).toEqual(
            expect.arrayContaining([
                {
                    'mcp.method.name': 'tools/call',
                    'gen_ai.operation.name': 'execute_tool',
                    'gen_ai.tool.name': 'greet',
                    'mcp.protocol.version': '2025-11-25'
                },
                {
                    'mcp.method.name': 'tools/call',
                    'gen_ai.operation.name': 'execute_tool',
                    'mcp.protocol.version': '2025-11-25',
                    'rpc.response.status_code': '-32602'
                }
            ])
        );
        expect(JSON.stringify(serverDuration.points)).not.toContain('nope');
        expect(JSON.stringify(clientDuration.points)).not.toContain('file:///readme.md');
    });
});

describe('OpenTelemetry over Streamable HTTP', () => {
    it('serves a modern-era call through createMcpHandler: HTTP attributes, and a link to the ambient HTTP span', async () => {
        const handler = createMcpHandler(() => {
            const server = new McpServer({ name: 'weather', version: '1.0.0' });
            registerGreet(server);
            return server;
        });
        cleanups.push(() => handler.close());
        // Stands in for HTTP instrumentation: each POST gets a span, active while the server handles it.
        const fetchWithHttpSpan = (url: string | URL, init?: RequestInit) =>
            sdk.tracer.startActiveSpan('POST', { kind: SpanKind.SERVER }, span =>
                handler.fetch(new Request(url, init)).finally(() => span.end())
            );
        const client = new Client({ name: 'agent', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), { fetch: fetchWithHttpSpan }));
        cleanups.push(() => client.close());

        await client.callTool({ name: 'greet', arguments: { name: 'Ada' } });

        const clientSpan = sdk.span('tools/call greet', SpanKind.CLIENT);
        const serverSpan = sdk.span('tools/call greet', SpanKind.SERVER);
        const httpSpan = sdk.spans().find(s => s.name === 'POST' && s.parentSpanContext?.spanId === clientSpan.spanContext().spanId)!;
        expect(httpSpan).toBeDefined();
        expect(serverSpan.parentSpanContext?.spanId).toBe(clientSpan.spanContext().spanId);
        expect(serverSpan.links.map(l => l.context.spanId)).toEqual([httpSpan.spanContext().spanId]);
        expect(serverSpan.attributes).toMatchObject({
            'mcp.protocol.version': '2026-07-28',
            'network.protocol.name': 'http',
            'network.transport': 'tcp'
        });
    });
});
