/**
 * The cache-hint surface for cacheable 2026-07-28 results:
 *
 *  - `ServerOptions.cacheHints` (per-operation hints for SDK-built results),
 *  - `registerResource(..., { cacheHint })` (per-resource hints),
 *  - configuration-time validation (`RangeError`),
 *  - precedence, resolved per field: handler-returned values (when valid)
 *    over the per-resource hint over the per-operation hint over the defaults
 *    `{ ttlMs: 0, cacheScope: 'private' }`,
 *  - and the era boundary: 2025-era responses never gain any of it.
 */
import type { JSONRPCMessage, JSONRPCRequest, MessageClassification } from '@modelcontextprotocol/core-internal';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    InMemoryTransport,
    PROTOCOL_VERSION_META_KEY,
    setNegotiatedProtocolVersion
} from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { invoke } from '../../src/server/invoke';
import { McpServer, ResourceTemplate } from '../../src/server/mcp';
import type { ServerOptions } from '../../src/server/server';
import { installModernOnlyHandlers, Server } from '../../src/server/server';

const MODERN_REVISION = '2026-07-28';
const MODERN: MessageClassification = { era: 'modern', revision: MODERN_REVISION };

const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
    [CLIENT_INFO_META_KEY]: { name: 'cache-hint-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};

const modernRequest = (method: string, params: Record<string, unknown> = {}): JSONRPCRequest =>
    ({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: { ...params, _meta: ENVELOPE }
    }) as JSONRPCRequest;

function buildMcpServer(options?: ServerOptions): McpServer {
    const mcpServer = new McpServer({ name: 'cache-hint-server', version: '1.0.0' }, options);
    mcpServer.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
        content: [{ type: 'text', text }]
    }));
    return mcpServer;
}

async function modernResult(mcpServer: McpServer, request: JSONRPCRequest): Promise<Record<string, unknown>> {
    setNegotiatedProtocolVersion(mcpServer.server, MODERN_REVISION);
    const response = await invoke(mcpServer, request, { classification: MODERN });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: Record<string, unknown> };
    return body.result;
}

describe('configuration-time validation', () => {
    it('rejects a negative ttlMs in ServerOptions.cacheHints with a RangeError', () => {
        expect(() => new McpServer({ name: 's', version: '1' }, { cacheHints: { 'tools/list': { ttlMs: -1 } } })).toThrowError(RangeError);
    });

    it('rejects a non-integer ttlMs and an unknown cacheScope with a RangeError', () => {
        expect(() => new Server({ name: 's', version: '1' }, { cacheHints: { 'resources/read': { ttlMs: 1.5 } } })).toThrowError(
            RangeError
        );
        expect(
            () => new Server({ name: 's', version: '1' }, { cacheHints: { 'server/discover': { cacheScope: 'shared' as never } } })
        ).toThrowError(RangeError);
    });

    it('rejects an invalid registerResource cacheHint with a RangeError', () => {
        const mcpServer = buildMcpServer();
        expect(() =>
            mcpServer.registerResource('bad', 'test://bad', { cacheHint: { ttlMs: -5 } }, async uri => ({
                contents: [{ uri: uri.href, text: 'x' }]
            }))
        ).toThrowError(RangeError);
    });
});

describe('modern (2026-07-28) responses', () => {
    it('fills the defaults when nothing is configured', async () => {
        const result = await modernResult(buildMcpServer(), modernRequest('tools/list'));
        expect(result).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private' });
    });

    it('uses the per-operation hint from ServerOptions.cacheHints for SDK-built list results', async () => {
        const mcpServer = buildMcpServer({ cacheHints: { 'tools/list': { ttlMs: 60_000, cacheScope: 'public' } } });
        const result = await modernResult(mcpServer, modernRequest('tools/list'));
        expect(result).toMatchObject({ resultType: 'complete', ttlMs: 60_000, cacheScope: 'public' });
    });

    it('uses the per-operation hint for server/discover', async () => {
        const server = new Server({ name: 'discover-server', version: '1.0.0' }, { cacheHints: { 'server/discover': { ttlMs: 30_000 } } });
        installModernOnlyHandlers(server, [MODERN_REVISION]);
        setNegotiatedProtocolVersion(server, MODERN_REVISION);
        const response = await invoke(server, modernRequest('server/discover'), { classification: MODERN });
        expect(response.status).toBe(200);
        const body = (await response.json()) as { result: Record<string, unknown> };
        expect(body.result).toMatchObject({ resultType: 'complete', ttlMs: 30_000, cacheScope: 'private' });
        expect(Array.isArray(body.result['supportedVersions'])).toBe(true);
    });

    it('uses the per-operation hint for prompts/list', async () => {
        const mcpServer = buildMcpServer({ cacheHints: { 'prompts/list': { ttlMs: 15_000, cacheScope: 'public' } } });
        mcpServer.registerPrompt('greeting', { description: 'Say hello' }, async () => ({
            messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }]
        }));
        const result = await modernResult(mcpServer, modernRequest('prompts/list'));
        expect(result).toMatchObject({ resultType: 'complete', ttlMs: 15_000, cacheScope: 'public' });
    });

    it('uses the per-operation hint for resources/list', async () => {
        const mcpServer = buildMcpServer({ cacheHints: { 'resources/list': { ttlMs: 20_000 } } });
        mcpServer.registerResource('plain', 'test://plain', {}, async uri => ({
            contents: [{ uri: uri.href, text: 'plain' }]
        }));
        const result = await modernResult(mcpServer, modernRequest('resources/list'));
        expect(result).toMatchObject({ resultType: 'complete', ttlMs: 20_000, cacheScope: 'private' });
    });

    it('uses the per-operation hint for resources/templates/list', async () => {
        const mcpServer = buildMcpServer({ cacheHints: { 'resources/templates/list': { ttlMs: 45_000, cacheScope: 'public' } } });
        mcpServer.registerResource(
            'templated',
            new ResourceTemplate('test://things/{id}', { list: undefined }),
            {},
            async (uri, { id }) => ({ contents: [{ uri: uri.href, text: `id=${String(id)}` }] })
        );
        const result = await modernResult(mcpServer, modernRequest('resources/templates/list'));
        expect(result).toMatchObject({ resultType: 'complete', ttlMs: 45_000, cacheScope: 'public' });
    });

    it('a per-resource cacheHint wins over the per-operation hint for that resource', async () => {
        const mcpServer = buildMcpServer({ cacheHints: { 'resources/read': { ttlMs: 1_000 } } });
        mcpServer.registerResource('hinted', 'test://hinted', { cacheHint: { ttlMs: 2_000, cacheScope: 'public' } }, async uri => ({
            contents: [{ uri: uri.href, text: 'hinted' }]
        }));
        const result = await modernResult(mcpServer, modernRequest('resources/read', { uri: 'test://hinted' }));
        expect(result).toMatchObject({ ttlMs: 2_000, cacheScope: 'public' });
    });

    it('the per-operation hint applies to resources registered without their own hint', async () => {
        const mcpServer = buildMcpServer({ cacheHints: { 'resources/read': { ttlMs: 1_000 } } });
        mcpServer.registerResource('plain', 'test://plain', {}, async uri => ({
            contents: [{ uri: uri.href, text: 'plain' }]
        }));
        const result = await modernResult(mcpServer, modernRequest('resources/read', { uri: 'test://plain' }));
        expect(result).toMatchObject({ ttlMs: 1_000, cacheScope: 'private' });
    });

    it('a per-resource hint setting only cacheScope still takes ttlMs from the per-operation hint (per-field resolution)', async () => {
        const mcpServer = buildMcpServer({ cacheHints: { 'resources/read': { ttlMs: 1_000 } } });
        mcpServer.registerResource('scoped', 'test://scoped', { cacheHint: { cacheScope: 'public' } }, async uri => ({
            contents: [{ uri: uri.href, text: 'scoped' }]
        }));
        const result = await modernResult(mcpServer, modernRequest('resources/read', { uri: 'test://scoped' }));
        expect(result).toMatchObject({ ttlMs: 1_000, cacheScope: 'public' });
    });

    it('a per-resource hint setting only ttlMs still takes cacheScope from the per-operation hint (per-field resolution)', async () => {
        const mcpServer = buildMcpServer({ cacheHints: { 'resources/read': { cacheScope: 'public' } } });
        mcpServer.registerResource('timed', 'test://timed', { cacheHint: { ttlMs: 2_000 } }, async uri => ({
            contents: [{ uri: uri.href, text: 'timed' }]
        }));
        const result = await modernResult(mcpServer, modernRequest('resources/read', { uri: 'test://timed' }));
        expect(result).toMatchObject({ ttlMs: 2_000, cacheScope: 'public' });
    });

    it('when both configured hints set the same fields, the per-resource values win for every field', async () => {
        const mcpServer = buildMcpServer({ cacheHints: { 'resources/read': { ttlMs: 1_000, cacheScope: 'private' } } });
        mcpServer.registerResource('full', 'test://full', { cacheHint: { ttlMs: 2_000, cacheScope: 'public' } }, async uri => ({
            contents: [{ uri: uri.href, text: 'full' }]
        }));
        const result = await modernResult(mcpServer, modernRequest('resources/read', { uri: 'test://full' }));
        expect(result).toMatchObject({ ttlMs: 2_000, cacheScope: 'public' });
    });

    it('a field neither configured author sets falls back to the default', async () => {
        const mcpServer = buildMcpServer({ cacheHints: { 'resources/read': { ttlMs: 1_000 } } });
        mcpServer.registerResource('partial', 'test://partial', { cacheHint: { ttlMs: 2_000 } }, async uri => ({
            contents: [{ uri: uri.href, text: 'partial' }]
        }));
        const result = await modernResult(mcpServer, modernRequest('resources/read', { uri: 'test://partial' }));
        expect(result).toMatchObject({ ttlMs: 2_000, cacheScope: 'private' });
    });

    it('fills the defaults for resources/read when neither configured author provides a hint', async () => {
        const mcpServer = buildMcpServer();
        mcpServer.registerResource('bare', 'test://bare', {}, async uri => ({
            contents: [{ uri: uri.href, text: 'bare' }]
        }));
        const result = await modernResult(mcpServer, modernRequest('resources/read', { uri: 'test://bare' }));
        expect(result).toMatchObject({ ttlMs: 0, cacheScope: 'private' });
    });

    it('valid handler-returned cache fields win over every configured hint', async () => {
        const mcpServer = buildMcpServer({ cacheHints: { 'resources/read': { ttlMs: 1_000 } } });
        mcpServer.registerResource('authored', 'test://authored', { cacheHint: { ttlMs: 2_000 } }, async uri => ({
            contents: [{ uri: uri.href, text: 'authored' }],
            ttlMs: 3_000,
            cacheScope: 'public'
        }));
        const result = await modernResult(mcpServer, modernRequest('resources/read', { uri: 'test://authored' }));
        expect(result).toMatchObject({ ttlMs: 3_000, cacheScope: 'public' });
    });

    it('invalid handler-returned values fall back to the configured hint', async () => {
        const mcpServer = buildMcpServer();
        mcpServer.registerResource('invalid', 'test://invalid', { cacheHint: { ttlMs: 2_000 } }, async uri => ({
            contents: [{ uri: uri.href, text: 'invalid' }],
            ttlMs: -10
        }));
        const result = await modernResult(mcpServer, modernRequest('resources/read', { uri: 'test://invalid' }));
        expect(result).toMatchObject({ ttlMs: 2_000, cacheScope: 'private' });
    });

    it('never leaks the cacheHint configuration into resources/list entries', async () => {
        const mcpServer = buildMcpServer();
        mcpServer.registerResource('hinted', 'test://hinted', { cacheHint: { ttlMs: 2_000 } }, async uri => ({
            contents: [{ uri: uri.href, text: 'hinted' }]
        }));
        const result = await modernResult(mcpServer, modernRequest('resources/list'));
        const resources = result['resources'] as Array<Record<string, unknown>>;
        expect(resources).toHaveLength(1);
        expect('cacheHint' in resources[0]!).toBe(false);
    });
});

describe('the 2025 era is never affected', () => {
    async function legacyExchange(mcpServer: McpServer, requests: JSONRPCMessage[]): Promise<JSONRPCMessage[]> {
        const [peerTx, serverTx] = InMemoryTransport.createLinkedPair();
        const sent: JSONRPCMessage[] = [];
        peerTx.onmessage = message => void sent.push(message);
        await peerTx.start();
        await mcpServer.server.connect(serverTx);
        for (const request of requests) {
            serverTx.onmessage?.(request);
        }
        await new Promise(resolve => setTimeout(resolve, 10));
        await mcpServer.close();
        return sent;
    }

    it('configured cache hints never reach a 2025-era response (no resultType, ttlMs or cacheScope on the wire)', async () => {
        const mcpServer = buildMcpServer({
            cacheHints: { 'tools/list': { ttlMs: 60_000, cacheScope: 'public' }, 'resources/read': { ttlMs: 1_000 } }
        });
        mcpServer.registerResource('hinted', 'test://hinted', { cacheHint: { ttlMs: 2_000 } }, async uri => ({
            contents: [{ uri: uri.href, text: 'hinted' }]
        }));

        const sent = await legacyExchange(mcpServer, [
            { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } as JSONRPCMessage,
            { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'test://hinted' } } as JSONRPCMessage,
            { jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} } as JSONRPCMessage
        ]);

        expect(sent).toHaveLength(3);
        for (const message of sent) {
            const json = JSON.stringify(message);
            expect(json).not.toContain('"resultType"');
            expect(json).not.toContain('"ttlMs"');
            expect(json).not.toContain('"cacheScope"');
            expect(json).not.toContain('"cacheHint"');
        }
    });
});
