/**
 * Regression test for https://github.com/modelcontextprotocol/typescript-sdk/issues/1956
 *
 * Per SEP-1303 (spec 2025-11-25), tool input validation failures must be
 * returned as Tool Execution Errors (a successful `CallToolResult` with
 * `isError: true`), not as JSON-RPC protocol errors. This lets the model
 * see the validation message and self-correct on retry.
 *
 * https://modelcontextprotocol.io/specification/2025-11-25/changelog
 */

import { Client } from '../../src/client/index.js';
import { InMemoryTransport } from '../../src/inMemory.js';
import { CallToolResultSchema, type CallToolResult } from '../../src/types.js';
import { McpServer } from '../../src/server/mcp.js';
import { zodTestMatrix, type ZodMatrixEntry } from '../../src/__fixtures__/zodTestMatrix.js';

describe.each(zodTestMatrix)('Issue #1956 (SEP-1303): $zodVersionLabel', (entry: ZodMatrixEntry) => {
    const { z } = entry;

    test('returns Tool Execution Error (not protocol error) for invalid tool input', async () => {
        const mcpServer = new McpServer({
            name: 'test server',
            version: '1.0'
        });
        const client = new Client({
            name: 'test client',
            version: '1.0'
        });

        mcpServer.registerTool(
            'add',
            {
                inputSchema: {
                    a: z.number(),
                    b: z.number()
                }
            },
            async ({ a, b }) => ({
                content: [{ type: 'text', text: String(a + b) }]
            })
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), mcpServer.server.connect(serverTransport)]);

        // Invoke with a wrong type for `b`. Per SEP-1303 the request should
        // resolve with isError: true (Tool Execution Error), not reject with
        // a JSON-RPC -32602 InvalidParams protocol error.
        const result = (await client.request(
            {
                method: 'tools/call',
                params: {
                    name: 'add',
                    arguments: { a: 1, b: 'two' }
                }
            },
            CallToolResultSchema
        )) as CallToolResult;

        // Must be a successful result, not a thrown McpError.
        expect(result).toBeDefined();
        expect(result.isError).toBe(true);

        // Content references the field name + tool name so the model can
        // self-correct on retry.
        expect(Array.isArray(result.content)).toBe(true);
        const text = result.content
            .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
            .map(part => part.text)
            .join('\n');
        expect(text).toContain('Input validation error');
        expect(text).toContain('add');
        expect(text).toContain('b');
    });

    test('does not invoke the tool handler when input validation fails', async () => {
        const mcpServer = new McpServer({
            name: 'test server',
            version: '1.0'
        });
        const client = new Client({
            name: 'test client',
            version: '1.0'
        });

        let handlerCalls = 0;
        mcpServer.registerTool(
            'echo',
            {
                inputSchema: {
                    message: z.string()
                }
            },
            async ({ message }) => {
                handlerCalls++;
                return { content: [{ type: 'text', text: message }] };
            }
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), mcpServer.server.connect(serverTransport)]);

        // Wrong type for `message`.
        const result = (await client.request(
            {
                method: 'tools/call',
                params: {
                    name: 'echo',
                    arguments: { message: 42 }
                }
            },
            CallToolResultSchema
        )) as CallToolResult;

        expect(result.isError).toBe(true);
        expect(handlerCalls).toBe(0);
    });
});
