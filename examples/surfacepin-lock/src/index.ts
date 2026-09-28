// Stdio MCP server in the current SDK shape: createServer + registerTool + serveStdio.
// SurfacePin locks the tools list from outside this file. Do not hash the surface here.
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'surfacepin-lock',
    version: '1.0.0',
  });

  server.registerTool(
    'greet',
    {
      description: 'Greet someone by name',
      inputSchema: z.object({
        name: z.string().describe('Name to greet'),
      }),
    },
    async ({ name }) => ({
      content: [{ type: 'text', text: `Hello, ${name}!` }],
    }),
  );

  return server;
}

void serveStdio(createServer);
console.error('surfacepin-lock MCP server running on stdio');
