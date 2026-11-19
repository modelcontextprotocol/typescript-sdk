// Regression test for #2838: each request converts only the tool schemas it needs.
import type { JSONRPCMessage, StandardSchemaWithJSON } from '@modelcontextprotocol/core-internal';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    InMemoryTransport,
    PROTOCOL_VERSION_META_KEY
} from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import { createMcpHandler } from '../../src/server/createMcpHandler';
import { McpServer } from '../../src/server/mcp';

const conversions: string[] = [];

function countingSchema(label: string): StandardSchemaWithJSON {
    const convert = () => {
        conversions.push(label);
        return { type: 'object' as const, properties: { value: { type: 'string' as const } } };
    };
    return {
        '~standard': { version: 1, vendor: 'counting', validate: value => ({ value }), jsonSchema: { input: convert, output: convert } }
    };
}

const schemas = [countingSchema('a'), countingSchema('b'), countingSchema('c')];
const outputOfA = countingSchema('out-a');

function buildServer(): McpServer {
    const server = new McpServer({ name: 'stateless', version: '0' });
    for (const [i, inputSchema] of schemas.entries()) {
        server.registerTool(`tool_${i}`, { inputSchema, ...(i === 0 ? { outputSchema: outputOfA } : {}) }, async () => ({
            content: [{ type: 'text', text: 'ok' }],
            structuredContent: { value: 'ok' }
        }));
    }
    return server;
}

function legacy(method: string, params: Record<string, unknown>): Request {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
}

function modern(method: string, params: Record<string, unknown>, name?: string): Request {
    const envelope = {
        [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
        [CLIENT_INFO_META_KEY]: { name: 'c', version: '0' },
        [CLIENT_CAPABILITIES_META_KEY]: {}
    };
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2026-07-28',
            'mcp-method': method,
            ...(name === undefined ? {} : { 'mcp-name': name })
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: envelope } })
    });
}

async function conversionsFor(request: Request): Promise<string[]> {
    const handler = createMcpHandler(buildServer);
    conversions.length = 0;
    const response = await handler.fetch(request);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"result"');
    return [...conversions];
}

// Connects a 2025-era peer to one long-lived server and returns a function that sends a request and resolves with its result.
async function connect(server: McpServer) {
    const [peer, serverSide] = InMemoryTransport.createLinkedPair();
    const waiters = new Map<unknown, (message: JSONRPCMessage) => void>();
    peer.onmessage = message => waiters.get((message as { id?: unknown }).id)?.(message);
    await server.connect(serverSide);
    await peer.start();
    let id = 0;
    const request = (method: string, params: Record<string, unknown>) =>
        new Promise<Record<string, unknown>>(resolve => {
            waiters.set(++id, message => resolve((message as { result?: Record<string, unknown> }).result ?? {}));
            void peer.send({ jsonrpc: '2.0', id, method, params });
        });
    await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '0' } });
    await peer.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return request;
}

describe('lazy tool schema conversion, seen through requests (#2838)', () => {
    it('a request that needs no tool schema converts nothing', async () => {
        const initialize = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '0' } };
        expect(await conversionsFor(legacy('initialize', initialize))).toEqual([]);
        expect(await conversionsFor(modern('server/discover', {}))).toEqual([]);
    });

    it('tools/call converts only schemas of the called tool', async () => {
        const callB = { name: 'tool_1', arguments: { value: 'x' } };
        expect(await conversionsFor(legacy('tools/call', callB))).toEqual([]);
        expect(await conversionsFor(modern('tools/call', callB, 'tool_1'))).toEqual(['b']);
        const callA = { name: 'tool_0', arguments: { value: 'x' } };
        expect(await conversionsFor(legacy('tools/call', callA))).toEqual(['out-a']);
        expect(await conversionsFor(modern('tools/call', callA, 'tool_0'))).toEqual(['a', 'out-a']);
    });

    it('tools/list converts each listed schema once', async () => {
        expect(await conversionsFor(legacy('tools/list', {}))).toEqual(['a', 'out-a', 'b', 'c']);
        expect(await conversionsFor(modern('tools/list', {}))).toEqual(['a', 'out-a', 'b', 'c']);
    });

    it('a long-lived server converts an output schema at most once, however often the tool is called', async () => {
        const request = await connect(buildServer());
        conversions.length = 0;
        for (let i = 0; i < 3; i++) await request('tools/call', { name: 'tool_0', arguments: { value: 'x' } });
        expect(conversions.filter(label => label === 'out-a').length).toBeLessThanOrEqual(1);
    });

    it('update({ outputSchema }) replaces the converted output schema', async () => {
        const server = new McpServer({ name: 'long-lived', version: '0' });
        const tool = server.registerTool('tool', { inputSchema: schemas[0]!, outputSchema: outputOfA }, async () => ({
            content: [],
            structuredContent: { value: 'ok' }
        }));
        const request = await connect(server);
        const before = await request('tools/call', { name: 'tool', arguments: {} });
        expect(before.structuredContent).toEqual({ value: 'ok' });

        const root = () => ({ anyOf: [{ type: 'string' as const }, { type: 'object' as const }] });
        const textOrObject: StandardSchemaWithJSON = {
            '~standard': { version: 1, vendor: 'counting', validate: value => ({ value }), jsonSchema: { input: root, output: root } }
        };
        tool.update({ outputSchema: textOrObject });
        // A 2025-era peer gets the result wrapped as { result } when the converted schema's root is not an object.
        const after = await request('tools/call', { name: 'tool', arguments: {} });
        expect(after.structuredContent).toEqual({ result: { value: 'ok' } });
    });
});
