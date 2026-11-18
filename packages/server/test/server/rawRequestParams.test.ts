import { PassThrough } from 'node:stream';

import type { JSONRPCMessage, JSONRPCRequest, ServerContext } from '@modelcontextprotocol/core-internal';
import {
    CLIENT_CAPABILITIES_META_KEY,
    InMemoryTransport,
    PROTOCOL_VERSION_META_KEY,
    setNegotiatedProtocolVersion
} from '@modelcontextprotocol/core-internal';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

import { Server } from '../../src/server/server';
import { StdioServerTransport } from '../../src/server/stdio';

const servers: Server[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.close()));
});

describe.each(['2025-11-25', '2026-07-28'])('raw request params on %s', revision => {
    const modern = revision === '2026-07-28';
    const envelope = modern ? { [PROTOCOL_VERSION_META_KEY]: revision, [CLIENT_CAPABILITIES_META_KEY]: {} } : {};

    async function call(
        params: Record<string, unknown>,
        handler: (request: { params: { name: string; arguments?: Record<string, unknown> } }, ctx: ServerContext) => void,
        includeRawRequestParams?: boolean
    ) {
        const server = new Server({ name: 'raw-params-test', version: '1' }, { capabilities: { tools: {} }, includeRawRequestParams });
        servers.push(server);
        setNegotiatedProtocolVersion(server, revision);
        server.setRequestHandler('tools/call', (request, ctx) => {
            handler(request, ctx);
            return { content: [] };
        });
        const [peer, transport] = InMemoryTransport.createLinkedPair();
        await server.connect(transport);
        await peer.start();
        const response = new Promise<JSONRPCMessage | { transportError: string }>(resolve => {
            peer.onmessage = resolve;
            server.onerror = error => resolve({ transportError: error.message });
        });
        const wireParams = { ...params, _meta: { ...envelope, ...(params._meta as Record<string, unknown> | undefined) } };
        // Simulate JSON wire serialization, including omission of undefined values.
        // eslint-disable-next-line unicorn/prefer-structured-clone
        await peer.send(JSON.parse(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: wireParams })) as JSONRPCRequest);
        return { response: await response, wireParams };
    }

    it.each([undefined, false])('keeps default stripping and omits raw params when opt-in is %s', async enabled => {
        const handler = vi.fn((request, ctx) => {
            expect(request.params).not.toHaveProperty('sentinel');
            expect(ctx.mcpReq).not.toHaveProperty('rawParams');
        });
        const { response } = await call({ name: 'echo', sentinel: { exact: [1, 'two'] } }, handler, enabled);
        expect(response).toHaveProperty('result');
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('preserves unknown siblings separately from the validated request', async () => {
        let observed: unknown;
        const handler = vi.fn((request, ctx) => {
            observed = ctx.mcpReq.rawParams;
            expect(request.params).not.toHaveProperty('sentinel');
            expect(request.params.arguments).toEqual({ text: 'wrapped' });
        });
        const { response, wireParams } = await call(
            { name: 'echo', arguments: { text: 'wrapped' }, sentinel: { exact: [1, 'two'] }, _meta: { traceparent: 'synthetic-trace' } },
            handler,
            true
        );
        expect(response).toHaveProperty('result');
        expect(observed).toEqual(wireParams);
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('preserves siblings after stdio transport metadata normalization', async () => {
        const server = new Server(
            { name: 'raw-params-stdio-test', version: '1' },
            { capabilities: { tools: {} }, includeRawRequestParams: true }
        );
        servers.push(server);
        setNegotiatedProtocolVersion(server, revision);
        const handler = vi.fn((request, ctx) => {
            expect(request.params).not.toHaveProperty('resource_type');
            expect(request.params).not.toHaveProperty('record_id');
            expect(ctx.mcpReq.rawParams).toEqual({
                name: 'echo',
                resource_type: 'people',
                record_id: 'synthetic-record',
                _meta: { ...envelope, 'io.modelcontextprotocol/related-task': { taskId: 't' } }
            });
            return { content: [] };
        });
        server.setRequestHandler('tools/call', handler);
        const input = new PassThrough();
        const output = new PassThrough();
        const response = new Promise<unknown>((resolve, reject) => {
            output.once('data', chunk => resolve(JSON.parse(chunk.toString())));
            server.onerror = reject;
        });
        await server.connect(new StdioServerTransport(input, output));
        input.write(
            JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'echo',
                    resource_type: 'people',
                    record_id: 'synthetic-record',
                    _meta: { ...envelope, 'io.modelcontextprotocol/related-task': { taskId: 't', extension: 'sentinel' } }
                }
            }) + '\n'
        );
        expect(await response).toHaveProperty('result');
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it.each([{ name: 12 }, { name: 'echo', arguments: [] }, { name: 'echo', _meta: { progressToken: {} } }])(
        'does not bypass known-field validation: %j',
        async params => {
            const baseline = vi.fn();
            const enabled = vi.fn();
            const before = await call(params, baseline);
            const after = await call(params, enabled, true);
            expect(before.response).toHaveProperty('_meta' in params ? 'transportError' : 'error');
            expect(after.response).toEqual(before.response);
            expect(baseline).not.toHaveBeenCalled();
            expect(enabled).not.toHaveBeenCalled();
        }
    );

    it.each(['accepted', 42])('lets an author schema accept or reject the raw sibling: %s', async sentinel => {
        const accepted: string[] = [];
        const { response } = await call(
            { name: 'echo', sentinel },
            (_request, ctx) => accepted.push(z.object({ sentinel: z.string() }).parse(ctx.mcpReq.rawParams).sentinel),
            true
        );
        expect(response).toHaveProperty(typeof sentinel === 'string' ? 'result' : 'error');
        expect(accepted).toEqual(typeof sentinel === 'string' ? [sentinel] : []);
    });

    it('keeps era-specific task and input-response handling separate from raw params', async () => {
        const handler = vi.fn((request, ctx) => {
            expect(ctx.mcpReq.rawParams).toHaveProperty('task', { ttl: 123, extension: 'unparsed' });
            if (modern) {
                expect(request.params).not.toHaveProperty('task');
                expect(request.params).not.toHaveProperty('inputResponses');
                expect(request.params).not.toHaveProperty('requestState');
                expect(ctx.mcpReq.inputResponses).toEqual({ answer: { action: 'accept' } });
                expect(ctx.mcpReq.droppedInputResponseKeys).toEqual(['invalid']);
                expect(ctx.mcpReq.requestState()).toBe('opaque-state');
            } else {
                expect(request.params).toHaveProperty('task', { ttl: 123 });
            }
        });
        const { response } = await call(
            {
                name: 'echo',
                task: { ttl: 123, extension: 'unparsed' },
                ...(modern && { inputResponses: { answer: { action: 'accept' }, invalid: 1 }, requestState: 'opaque-state' })
            },
            handler,
            true
        );
        expect(response).toHaveProperty('result');
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('keeps a known-field collision governed by its schema rather than merging raw values', async () => {
        const params = { name: 'echo', task: { ttl: 'invalid' } };
        const baseline = vi.fn();
        const enabled = vi.fn();
        const before = await call(params, baseline);
        const after = await call(params, enabled, true);
        expect(after.response).toEqual(before.response);
        expect(after.response).toHaveProperty(modern ? 'result' : 'error');
        expect(enabled).toHaveBeenCalledTimes(modern ? 1 : 0);
    });
});
