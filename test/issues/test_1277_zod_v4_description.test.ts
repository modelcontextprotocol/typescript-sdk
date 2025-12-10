/**
 * Regression test for https://github.com/modelcontextprotocol/typescript-sdk/issues/1277
 *
 * Zod v4 stores `.describe()` descriptions directly on the schema object,
 * not in `._zod.def.description`. This test verifies that descriptions are
 * correctly extracted for prompt arguments.
 */

import { Client } from '../../src/client/index.js';
import { InMemoryTransport } from '../../src/inMemory.js';
import { ListPromptsResultSchema } from '../../src/types.js';
import { McpServer } from '../../src/server/mcp.js';
import { zodTestMatrix, type ZodMatrixEntry } from '../../src/__fixtures__/zodTestMatrix.js';

describe.each(zodTestMatrix)('Issue #1277: $zodVersionLabel', (entry: ZodMatrixEntry) => {
    const { z } = entry;

    test('should preserve argument descriptions from .describe()', async () => {
        const mcpServer = new McpServer({
            name: 'test server',
            version: '1.0'
        });
        const client = new Client({
            name: 'test client',
            version: '1.0'
        });

        mcpServer.prompt(
            'test',
            {
                name: z.string().describe('The user name'),
                value: z.string().describe('The value to set')
            },
            async ({ name, value }) => ({
                messages: [
                    {
                        role: 'assistant',
                        content: {
                            type: 'text',
                            text: `${name}: ${value}`
                        }
                    }
                ]
            })
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), mcpServer.server.connect(serverTransport)]);

        const result = await client.request(
            {
                method: 'prompts/list'
            },
            ListPromptsResultSchema
        );

        expect(result.prompts).toHaveLength(1);
        expect(result.prompts[0].name).toBe('test');
        expect(result.prompts[0].arguments).toEqual([
            { name: 'name', required: true, description: 'The user name' },
            { name: 'value', required: true, description: 'The value to set' }
        ]);
    });
});
