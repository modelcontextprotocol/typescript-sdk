/**
 * Regression test for https://github.com/modelcontextprotocol/typescript-sdk/issues/400
 *
 * When a tool has all optional parameters, some LLM models call the tool without
 * providing an `arguments` field. This test verifies that undefined arguments are
 * handled correctly by defaulting to an empty object.
 */

import { Client } from '@modelcontextprotocol/client';
import { CallToolResultSchema, InMemoryTransport } from '@modelcontextprotocol/core';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

describe('Issue #400: Zod v4', () => {
    test('should accept undefined arguments when all tool params are optional', async () => {
        const mcpServer = new McpServer({
            name: 'test server',
            version: '1.0'
        });
        const client = new Client({
            name: 'test client',
            version: '1.0'
        });

        mcpServer.registerTool(
            'optional-params-tool',
            {
                inputSchema: z.object({
                    limit: z.number().optional(),
                    offset: z.number().optional()
                })
            },
            async ({ limit, offset }) => ({
                content: [
                    {
                        type: 'text',
                        text: `limit: ${limit ?? 'default'}, offset: ${offset ?? 'default'}`
                    }
                ]
            })
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), mcpServer.server.connect(serverTransport)]);

        // Call tool without arguments (arguments is undefined)
        const result = await client.request(
            {
                method: 'tools/call',
                params: {
                    name: 'optional-params-tool'
                    // arguments is intentionally omitted (undefined)
                }
            },
            CallToolResultSchema
        );

        expect(result.isError).toBeUndefined();
        expect(result.content).toEqual([
            {
                type: 'text',
                text: 'limit: default, offset: default'
            }
        ]);
    });
});
