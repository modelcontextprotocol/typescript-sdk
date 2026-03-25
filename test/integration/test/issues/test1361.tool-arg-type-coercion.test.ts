/**
 * Regression test for https://github.com/modelcontextprotocol/typescript-sdk/issues/1361
 *
 * LLM models frequently send string values for non-string tool parameters
 * (e.g. "42" instead of 42, "true" instead of true). The SDK should coerce
 * these to the expected types before schema validation.
 */

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/core';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

async function setupAndCall(
    schema: Parameters<typeof McpServer.prototype.registerTool>[1] & { inputSchema: unknown },
    args: Record<string, unknown>
) {
    const mcpServer = new McpServer({ name: 'test server', version: '1.0' });
    const client = new Client({ name: 'test client', version: '1.0' });

    let receivedArgs: unknown;
    mcpServer.registerTool('test-tool', schema, async toolArgs => {
        receivedArgs = toolArgs;
        return { content: [{ type: 'text', text: JSON.stringify(toolArgs) }] };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), mcpServer.server.connect(serverTransport)]);

    const result = await client.request({
        method: 'tools/call',
        params: { name: 'test-tool', arguments: args }
    });

    return { result, receivedArgs };
}

describe('Issue #1361: Tool argument type coercion', () => {
    test('coerces string to number', async () => {
        const { receivedArgs } = await setupAndCall({ inputSchema: z.object({ count: z.number() }) }, { count: '42' });
        expect(receivedArgs).toEqual({ count: 42 });
    });

    test('coerces string to integer (truncates decimals)', async () => {
        const { receivedArgs } = await setupAndCall({ inputSchema: z.object({ page: z.int() }) }, { page: '3.9' });
        expect(receivedArgs).toEqual({ page: 3 });
    });

    test('coerces string "true"/"false" to boolean', async () => {
        const { receivedArgs } = await setupAndCall({ inputSchema: z.object({ verbose: z.boolean() }) }, { verbose: 'true' });
        expect(receivedArgs).toEqual({ verbose: true });
    });

    test('coerces string "false" to boolean false', async () => {
        const { receivedArgs } = await setupAndCall({ inputSchema: z.object({ verbose: z.boolean() }) }, { verbose: 'false' });
        expect(receivedArgs).toEqual({ verbose: false });
    });

    test('coerces number to string', async () => {
        const { receivedArgs } = await setupAndCall({ inputSchema: z.object({ label: z.string() }) }, { label: 42 });
        expect(receivedArgs).toEqual({ label: '42' });
    });

    test('coerces boolean to string', async () => {
        const { receivedArgs } = await setupAndCall({ inputSchema: z.object({ flag: z.string() }) }, { flag: true });
        expect(receivedArgs).toEqual({ flag: 'true' });
    });

    test('does not coerce non-numeric strings to number', async () => {
        const { result } = await setupAndCall({ inputSchema: z.object({ count: z.number() }) }, { count: 'not-a-number' });
        expect(result.isError).toBe(true);
    });

    test('does not coerce truthy strings other than "true"/"false" to boolean', async () => {
        const { result } = await setupAndCall({ inputSchema: z.object({ verbose: z.boolean() }) }, { verbose: 'yes' });
        expect(result.isError).toBe(true);
    });

    test('coerces nested object properties', async () => {
        const { receivedArgs } = await setupAndCall(
            {
                inputSchema: z.object({
                    config: z.object({
                        timeout: z.number(),
                        debug: z.boolean()
                    })
                })
            },
            { config: { timeout: '30', debug: 'true' } }
        );
        expect(receivedArgs).toEqual({ config: { timeout: 30, debug: true } });
    });

    test('passes through correctly-typed values unchanged', async () => {
        const { receivedArgs } = await setupAndCall(
            {
                inputSchema: z.object({
                    count: z.number(),
                    name: z.string(),
                    verbose: z.boolean()
                })
            },
            { count: 42, name: 'test', verbose: true }
        );
        expect(receivedArgs).toEqual({ count: 42, name: 'test', verbose: true });
    });

    test('handles optional parameters with coercion', async () => {
        const { receivedArgs } = await setupAndCall(
            {
                inputSchema: z.object({
                    limit: z.number().optional(),
                    offset: z.number().optional()
                })
            },
            { limit: '10' }
        );
        expect(receivedArgs).toEqual({ limit: 10 });
    });

    test('does not coerce empty string to number', async () => {
        const { result } = await setupAndCall({ inputSchema: z.object({ count: z.number() }) }, { count: '' });
        expect(result.isError).toBe(true);
    });
});
