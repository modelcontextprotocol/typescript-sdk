import process from 'node:process';
import { setInterval } from 'node:timers';

// eslint-disable-next-line import/no-unresolved
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import { z } from 'zod';

const transport = new StdioServerTransport();
const server = new McpServer({ name: 'fake-mcp', version: '1.0.0' });

server.tool(
  'ping',
  'Returns a canned response',
  { message: z.string().describe('Message to echo') },
  async ({ message }) => ({
    content: [
      {
        type: 'text',
        text: `pong: ${message}`,
      },
    ],
  })
);

await server.connect(transport);

process.stdin.on('end', async () => {
  await server.close();
  process.exit(0);
});

setInterval(() => {}, 60_000);
