/**
 * Bun integration test
 *
 * Verifies the MCP server and client packages work natively on Bun.
 * Run with: bun test test/server/bun.test.ts
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
// eslint-disable-next-line import/no-unresolved
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as z from 'zod/v4';

describe('MCP on Bun', () => {
    let httpServer: ReturnType<typeof Bun.serve>;

    // A stateless transport serves one request: connect a new pair for each.
    async function connectPair(): Promise<WebStandardStreamableHTTPServerTransport> {
        const mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' });

        mcpServer.registerTool(
            'greet',
            {
                description: 'Greet someone',
                inputSchema: z.object({ name: z.string() })
            },
            async ({ name }) => ({
                content: [{ type: 'text' as const, text: `Hello, ${name}!` }]
            })
        );

        const transport = new WebStandardStreamableHTTPServerTransport();
        await mcpServer.connect(transport);
        return transport;
    }

    beforeAll(() => {
        httpServer = Bun.serve({
            port: 0,
            fetch: async req => {
                const transport = await connectPair();
                return transport.handleRequest(req);
            }
        });
    });

    afterAll(() => {
        httpServer?.stop();
    });

    it('should handle MCP tool calls', async () => {
        const client = new Client({ name: 'test-client', version: '1.0.0' });
        const clientTransport = new StreamableHTTPClientTransport(new URL(`http://localhost:${httpServer.port}`));

        await client.connect(clientTransport);

        const result = await client.callTool({ name: 'greet', arguments: { name: 'Bun' } });
        expect(result.content).toEqual([{ type: 'text', text: 'Hello, Bun!' }]);

        await client.close();
    });
});
