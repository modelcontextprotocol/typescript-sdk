import type { JSONRPCErrorResponse, JSONRPCMessage, JSONRPCRequest, JSONRPCResultResponse } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core-internal';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as z from 'zod/v4';

import type { AroundMcpRequest, HandlerResultTypeMap, McpRequestMethod, RequestTypeMap } from '../../src/index';
import { McpServer, ResourceTemplate, Server } from '../../src/index';

async function wire(server: McpServer | Server) {
    const [peerTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const waiters = new Map<string | number, (message: JSONRPCMessage) => void>();
    peerTransport.onmessage = message => {
        if ('id' in message && message.id !== undefined) {
            waiters.get(message.id)?.(message);
            waiters.delete(message.id);
        }
    };
    await server.connect(serverTransport);
    await peerTransport.start();

    const request = (message: JSONRPCRequest): Promise<JSONRPCMessage> =>
        new Promise(resolve => {
            waiters.set(message.id, resolve);
            void peerTransport.send(message);
        });

    await request({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'around-test-client', version: '1.0.0' }
        }
    });
    await peerTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    return { request, close: () => server.close() };
}

function resultOf(message: JSONRPCMessage): Record<string, unknown> {
    return (message as JSONRPCResultResponse).result as Record<string, unknown>;
}

function errorOf(message: JSONRPCMessage): JSONRPCErrorResponse['error'] {
    return (message as JSONRPCErrorResponse).error;
}

function isNamedToolArray(value: unknown): value is Array<{ name: string }> {
    return (
        Array.isArray(value) &&
        value.every(tool => typeof tool === 'object' && tool !== null && 'name' in tool && typeof tool.name === 'string')
    );
}

describe('ServerOptions.aroundMcpRequest', () => {
    it('intercepts exactly the seven high-level primitive operations', async () => {
        const methods: McpRequestMethod[] = [];
        const server = new McpServer(
            { name: 'around-test', version: '1.0.0' },
            {
                aroundMcpRequest: async (method, request, _ctx, next) => {
                    methods.push(method);
                    const result = await next();
                    if (request.method === 'tools/list' && 'tools' in result && isNamedToolArray(result.tools)) {
                        result.tools = result.tools.filter(tool => !tool.name.startsWith('_'));
                    }
                    return result;
                }
            }
        );
        server.registerTool('echo', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
        server.registerTool('_hidden', {}, async () => ({ content: [{ type: 'text', text: 'hidden' }] }));
        server.registerPrompt('hello', {}, async () => ({
            messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }]
        }));
        server.registerResource('static', 'file:///static', {}, async uri => ({
            contents: [{ uri: uri.href, text: 'static' }]
        }));
        server.registerResource('template', new ResourceTemplate('file:///{name}', { list: undefined }), {}, async uri => ({
            contents: [{ uri: uri.href, text: 'template' }]
        }));

        const connection = await wire(server);
        const requests: JSONRPCRequest[] = [
            { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
            { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: {} } },
            { jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} },
            { jsonrpc: '2.0', id: 4, method: 'resources/templates/list', params: {} },
            { jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'file:///static' } },
            { jsonrpc: '2.0', id: 6, method: 'prompts/list', params: {} },
            { jsonrpc: '2.0', id: 7, method: 'prompts/get', params: { name: 'hello' } },
            { jsonrpc: '2.0', id: 8, method: 'ping', params: {} }
        ];
        let listResult: Record<string, unknown> | undefined;
        for (const request of requests) {
            const response = await connection.request(request);
            if (request.method === 'tools/list') listResult = resultOf(response);
        }

        expect(methods).toEqual([
            'tools/list',
            'tools/call',
            'resources/list',
            'resources/templates/list',
            'resources/read',
            'prompts/list',
            'prompts/get'
        ]);
        expect(listResult?.tools).toEqual([expect.objectContaining({ name: 'echo' })]);
        await connection.close();
    });

    it('runs after tool routing and input transforms, and before output validation', async () => {
        const interceptedArguments: unknown[] = [];
        const server = new McpServer(
            { name: 'around-test', version: '1.0.0' },
            {
                aroundMcpRequest: async (method, request, _ctx, next) => {
                    if (request.method === 'tools/call') {
                        interceptedArguments.push(request.params.arguments);
                        const result = await next();
                        if ('structuredContent' in result && request.params.name === 'corrupt') {
                            result.structuredContent = { value: 42 };
                        }
                        return result;
                    }
                    return next();
                }
            }
        );
        const inputSchema = z.object({ value: z.string().transform(value => Number(value)) });
        const outputSchema = z.object({ value: z.string() });
        server.registerTool('corrupt', { inputSchema, outputSchema }, async ({ value }) => ({
            content: [{ type: 'text', text: String(value) }],
            structuredContent: { value: String(value) }
        }));

        const connection = await wire(server);
        const invalid = await connection.request({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'missing', arguments: { value: '3' } }
        });
        expect(errorOf(invalid).code).toBe(-32602);
        expect(interceptedArguments).toEqual([]);

        const response = resultOf(
            await connection.request({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: { name: 'corrupt', arguments: { value: '3' } }
            })
        );
        expect(interceptedArguments).toEqual([{ value: 3 }]);
        expect(response.isError).toBe(true);
        expect(response.content).toEqual([expect.objectContaining({ text: expect.stringContaining('Output validation error') })]);
        await connection.close();
    });

    it('keeps interceptor errors inside the normal tools/call isError conversion', async () => {
        const server = new McpServer(
            { name: 'around-test', version: '1.0.0' },
            {
                aroundMcpRequest: async (method, _request, _ctx, next) => {
                    if (method === 'tools/call') throw new Error('blocked by interceptor');
                    return next();
                }
            }
        );
        server.registerTool('echo', {}, async () => ({ content: [{ type: 'text', text: 'unreachable' }] }));

        const connection = await wire(server);
        const result = resultOf(
            await connection.request({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: 'echo', arguments: {} }
            })
        );
        expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'blocked by interceptor' }] });
        await connection.close();
    });

    it('validates and routes prompts and resources before interception', async () => {
        const intercepted: McpRequestMethod[] = [];
        const server = new McpServer(
            { name: 'around-test', version: '1.0.0' },
            {
                aroundMcpRequest: async (method, _request, _ctx, next) => {
                    intercepted.push(method);
                    return next();
                }
            }
        );
        server.registerPrompt('hello', { argsSchema: z.object({ topic: z.string().min(2) }) }, async ({ topic }) => ({
            messages: [{ role: 'user', content: { type: 'text', text: topic } }]
        }));
        server.registerResource('static', 'file:///static', {}, async uri => ({ contents: [{ uri: uri.href, text: 'ok' }] }));

        const connection = await wire(server);
        const invalidPrompt = await connection.request({
            jsonrpc: '2.0',
            id: 1,
            method: 'prompts/get',
            params: { name: 'hello', arguments: { topic: 'x' } }
        });
        const missingResource = await connection.request({
            jsonrpc: '2.0',
            id: 2,
            method: 'resources/read',
            params: { uri: 'file:///missing' }
        });

        expect(errorOf(invalidPrompt).code).toBe(-32602);
        expect(errorOf(missingResource).code).toBe(-32602);
        expect(intercepted).toEqual([]);
        await connection.close();
    });

    it('does not apply the high-level interceptor to low-level handlers', async () => {
        let intercepted = false;
        const server = new Server(
            { name: 'low-level', version: '1.0.0' },
            {
                capabilities: { tools: {} },
                aroundMcpRequest: async (_method, _request, _ctx, next) => {
                    intercepted = true;
                    return next();
                }
            }
        );
        server.setRequestHandler('tools/list', async () => ({ tools: [] }));

        const connection = await wire(server);
        expect(resultOf(await connection.request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))).toEqual({
            tools: []
        });
        expect(intercepted).toBe(false);
        await connection.close();
    });

    it('exports an SDK-derived generic callback contract', () => {
        const around: AroundMcpRequest = async (_method, _request, _ctx, next) => next();
        expectTypeOf(around).toEqualTypeOf<AroundMcpRequest>();
        expectTypeOf<RequestTypeMap['tools/call']>().toMatchObjectType<{ method: 'tools/call' }>();
        expectTypeOf<HandlerResultTypeMap['resources/read']>().not.toEqualTypeOf<never>();
    });
});
