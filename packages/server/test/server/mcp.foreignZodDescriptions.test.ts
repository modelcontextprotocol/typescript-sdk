import type { JSONRPCMessage, StandardSchemaWithJSON } from '@modelcontextprotocol/core';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as zOld from 'zod-v40';

import { McpServer } from '../../src/index.js';

// `zod-v40` is an npm alias for zod@4.0.x: a real second zod instance that implements
// StandardSchemaV1 but not `~standard.jsonSchema` (added in 4.2). An application that
// registers tools with schemas from its own zod 4.0/4.1 (or the zod@3.25.x `zod/v4`
// subpath) hits the bundled-converter fallback when the tool list is served. This test
// pins the end-to-end behavior a connected peer observes: the advertised tool schema
// retains `.describe()` metadata, and validated tool calls still round-trip.

type ProfileInput = { name: string; address: { street: string }; primaryLabel?: string; secondaryLabel?: string };

describe('tools/list over a transport with a foreign-zod inputSchema', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('advertises .describe() descriptions and validates calls end-to-end', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        const server = new McpServer({ name: 't', version: '1.0.0' });
        const label = zOld.string().describe('a short label').optional();
        let received: unknown;
        server.registerTool(
            'create-profile',
            {
                description: 'creates a profile',
                inputSchema: zOld
                    .object({
                        name: zOld.string().describe('the display name'),
                        address: zOld.object({ street: zOld.string().describe('street and house number') }).describe('postal address'),
                        // One schema instance reused at two positions: both occurrences
                        // must carry the description in the advertised schema.
                        primaryLabel: label,
                        secondaryLabel: label
                    })
                    .describe('profile input') as unknown as StandardSchemaWithJSON<ProfileInput, ProfileInput>
            },
            async args => {
                received = args;
                return { content: [{ type: 'text' as const, text: 'ok' }] };
            }
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

        await vi.waitFor(() => expect(responses.some(r => 'id' in r && r.id === 2)).toBe(true));

        const list = responses.find(r => 'id' in r && r.id === 2) as {
            result?: { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
        };
        const tool = list.result?.tools.find(t => t.name === 'create-profile');
        expect(tool).toBeDefined();
        const schema = tool?.inputSchema as {
            description?: string;
            properties?: Record<string, { description?: string; properties?: Record<string, { description?: string }> }>;
        };
        // What the connected peer actually sees: descriptions survive the fallback conversion.
        expect(schema.description).toBe('profile input');
        expect(schema.properties?.name?.description).toBe('the display name');
        expect(schema.properties?.address?.description).toBe('postal address');
        expect(schema.properties?.address?.properties?.street?.description).toBe('street and house number');
        expect(schema.properties?.primaryLabel?.description).toBe('a short label');
        expect(schema.properties?.secondaryLabel?.description).toBe('a short label');

        // The foreign schema also still validates calls (cross-instance `~standard.validate`).
        await client.send({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'create-profile', arguments: { name: 'Ada', address: { street: 'Main St 1' } } }
        } as JSONRPCMessage);
        await vi.waitFor(() => expect(responses.some(r => 'id' in r && r.id === 3)).toBe(true));
        expect(received).toEqual({ name: 'Ada', address: { street: 'Main St 1' } });

        await server.close();
    });
});
