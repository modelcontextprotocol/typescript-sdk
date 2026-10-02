import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core-internal';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import { McpServer } from '../../src/index';
import { AjvJsonSchemaValidator } from '../../src/validators/ajv';

/**
 * Regression tests for #2464: the schemas advertised in `tools/list` must describe
 * the raw payloads the server actually ships — a `z.date()` field must not fail the
 * whole listing, and a valid `structuredContent` must satisfy the advertised
 * `outputSchema` when re-validated by a spec-compliant client.
 */

type ResponseMessage = { id?: number; result?: Record<string, never>; error?: { message: string } };

async function connectRawClient(server: McpServer) {
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

    const request = async (id: number, method: string, params?: Record<string, unknown>) => {
        await client.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage);
        await vi.waitFor(() => expect(responses.some(r => 'id' in r && r.id === id)).toBe(true));
        return responses.find(r => 'id' in r && r.id === id) as ResponseMessage;
    };

    return { request };
}

describe('tools/list with z.date() in a tool schema (#2464)', () => {
    it('lists all tools and advertises the date field as string/date-time', async () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        server.registerTool('plain', { inputSchema: { x: z.number() } }, async ({ x }) => ({
            content: [{ type: 'text' as const, text: String(x) }]
        }));
        server.registerTool('dated', { inputSchema: { when: z.date() } }, async () => ({ content: [] }));

        const { request } = await connectRawClient(server);
        const response = (await request(2, 'tools/list')) as {
            result?: { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> };
            error?: { message: string };
        };

        // Before the fix, one z.date() tool failed the ENTIRE tools/list response
        // ("Date cannot be represented in JSON Schema").
        expect(response.error).toBeUndefined();
        const tools = response.result?.tools ?? [];
        expect(tools.map(t => t.name).sort()).toEqual(['dated', 'plain']);
        expect(tools.find(t => t.name === 'dated')?.inputSchema.properties?.when).toEqual({
            type: 'string',
            format: 'date-time'
        });

        await server.close();
    });
});

describe('advertised outputSchema accepts the raw structuredContent the server ships (#2464)', () => {
    it('a payload omitting a defaulted field and carrying an extra key satisfies the advertised schema', async () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        server.registerTool(
            'echo',
            { inputSchema: {}, outputSchema: { counted: z.number().default(0), name: z.string() } },
            // Omits the defaulted `counted` and returns an extra key — both pass zod
            // validation (defaults filled, extras tolerated), and the raw object ships.
            async () => ({ content: [], structuredContent: { name: 'x', sneaky: true } as unknown as { name: string } })
        );

        const { request } = await connectRawClient(server);

        const list = (await request(2, 'tools/list')) as {
            result?: { tools: Array<{ outputSchema?: Record<string, unknown> }> };
        };
        const outputSchema = list.result?.tools[0]?.outputSchema;
        expect(outputSchema).toBeDefined();

        const call = (await request(3, 'tools/call', { name: 'echo', arguments: {} })) as {
            result?: { isError?: boolean; structuredContent?: unknown };
            error?: { message: string };
        };
        expect(call.error).toBeUndefined();
        expect(call.result?.isError).toBeFalsy();
        expect(call.result?.structuredContent).toEqual({ name: 'x', sneaky: true });

        // Re-validate the shipped payload against the advertised schema, exactly as the
        // SDK's own Client does. Before the fix this failed with "must have required
        // property 'counted'" and "must NOT have additional properties".
        const validate = new AjvJsonSchemaValidator().getValidator(outputSchema!);
        expect(validate(call.result?.structuredContent)).toEqual({
            valid: true,
            data: { name: 'x', sneaky: true },
            errorMessage: undefined
        });

        await server.close();
    });
});
