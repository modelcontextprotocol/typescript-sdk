/**
 * Bun integration test
 *
 * Verifies the MCP server and client packages work natively on Bun.
 * Run with: bun test test/server/bun.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';

describe('MCP on Bun', () => {
  let httpServer: ReturnType<typeof Bun.serve>;
  let transport: WebStandardStreamableHTTPServerTransport;

  beforeAll(async () => {
    const mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' });

    mcpServer.registerTool('greet', {
      description: 'Greet someone',
      inputSchema: z.object({ name: z.string() }),
    }, async ({ name }) => ({
      content: [{ type: 'text' as const, text: `Hello, ${name}!` }],
    }));

    transport = new WebStandardStreamableHTTPServerTransport();
    await mcpServer.connect(transport);

    httpServer = Bun.serve({
      port: 0,
      fetch: (req) => transport.handleRequest(req),
    });
  });

  afterAll(async () => {
    await transport?.close();
    httpServer?.stop();
  });

  it('should handle MCP tool calls', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const clientTransport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${httpServer.port}`)
    );

    await client.connect(clientTransport);

    const result = await client.callTool({ name: 'greet', arguments: { name: 'Bun' } });
    expect(result.content).toEqual([{ type: 'text', text: 'Hello, Bun!' }]);

    await client.close();
  });
});
