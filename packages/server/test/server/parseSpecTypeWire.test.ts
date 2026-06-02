import type { CallToolResult, JSONRPCMessage, ListToolsResult } from '@modelcontextprotocol/core';
import {
    InMemoryTransport,
    LATEST_PROTOCOL_VERSION,
    parseSpecType,
    safeParseSpecType,
    SpecTypeValidationError
} from '@modelcontextprotocol/core';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import * as z from 'zod/v4';

import { McpServer } from '../../src/index.js';

// Validates real wire payloads with parseSpecType/safeParseSpecType — the
// replacement for the v1 pattern of calling SomeResultSchema.parse() on a
// response received from a live server, rather than on hand-built fixtures.
describe('parseSpecType on wire data', () => {
    async function roundTrip(): Promise<{ callToolResult: unknown; listToolsResult: unknown }> {
        const server = new McpServer({ name: 't', version: '1.0.0' });
        server.registerTool(
            'add',
            { description: 'adds two numbers', inputSchema: { a: z.number(), b: z.number() } },
            async ({ a, b }) => ({
                content: [{ type: 'text' as const, text: String(a + b) }],
                structuredContent: undefined
            })
        );

        const [client, srv] = InMemoryTransport.createLinkedPair();
        await server.connect(srv);
        await client.start();

        const responses: JSONRPCMessage[] = [];
        client.onmessage = m => responses.push(m);

        await client.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: 'c', version: '1.0.0' }
            }
        } as JSONRPCMessage);
        await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
        await client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } as JSONRPCMessage);
        await client.send({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'add', arguments: { a: 2, b: 5 } }
        } as JSONRPCMessage);

        await vi.waitFor(() => expect(responses.some(r => 'id' in r && r.id === 3)).toBe(true));
        const byId = (id: number) => responses.find(r => 'id' in r && r.id === id) as { result?: unknown } | undefined;
        const listToolsResult = byId(2)?.result;
        const callToolResult = byId(3)?.result;
        await server.close();
        return { callToolResult, listToolsResult };
    }

    it('parses a tools/call result received over a real transport', async () => {
        const { callToolResult } = await roundTrip();

        const parsed = parseSpecType('CallToolResult', callToolResult);
        expectTypeOf(parsed).toEqualTypeOf<CallToolResult>();
        expect(parsed.content).toEqual([{ type: 'text', text: '7' }]);
    });

    it('parses a tools/list result received over a real transport, preserving advertised schema', async () => {
        const { listToolsResult } = await roundTrip();

        const parsed = parseSpecType('ListToolsResult', listToolsResult);
        expectTypeOf(parsed).toEqualTypeOf<ListToolsResult>();
        expect(parsed.tools).toHaveLength(1);
        expect(parsed.tools[0]?.name).toBe('add');
        expect(parsed.tools[0]?.description).toBe('adds two numbers');
        expect(parsed.tools[0]?.inputSchema.type).toBe('object');
    });

    it('rejects the same wire payload when validated as a different spec type', async () => {
        const { callToolResult } = await roundTrip();

        expect(() => parseSpecType('Implementation', callToolResult)).toThrowError(SpecTypeValidationError);
        const parsed = safeParseSpecType('Implementation', callToolResult);
        expect(parsed.success).toBe(false);
        if (!parsed.success) {
            expect(parsed.issues.length).toBeGreaterThan(0);
        }
    });
});
