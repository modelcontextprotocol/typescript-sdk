/**
 * Deno integration test
 *
 * Verifies the MCP server and client packages work natively on Deno.
 * Run with: deno test --no-check --allow-net --allow-read --allow-env test/server/deno.test.ts
 */

import assert from 'node:assert/strict';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

Deno.test({
    name: 'MCP tool calls work on Deno',
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
        // A stateless transport serves one request: connect a new pair for each.
        const connectPair = async (): Promise<WebStandardStreamableHTTPServerTransport> => {
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
        };

        const httpServer = Deno.serve({ port: 0 }, async req => {
            const transport = await connectPair();
            return transport.handleRequest(req);
        });
        const port = httpServer.addr.port;

        try {
            const client = new Client({ name: 'test-client', version: '1.0.0' });
            const clientTransport = new StreamableHTTPClientTransport(new URL(`http://localhost:${port}`));

            await client.connect(clientTransport);

            const result = await client.callTool({ name: 'greet', arguments: { name: 'Deno' } });
            assert.deepStrictEqual(result.content, [{ type: 'text', text: 'Hello, Deno!' }]);

            await client.close();
        } finally {
            await httpServer.shutdown();
        }
    }
});
