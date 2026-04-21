/**
 * Stateless hello-world MCP server. No connect(), no transport instance —
 * one McpServer at module scope, handleHttp() per request.
 *
 * Run: npx tsx examples/server/src/helloStateless.ts
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { z } from 'zod/v4';

import { McpServer } from '@modelcontextprotocol/server';

const mcp = new McpServer({ name: 'hello-stateless', version: '1.0.0' });

mcp.registerTool(
    'greet',
    { description: 'Say hello', inputSchema: z.object({ name: z.string() }) },
    async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}!` }] })
);

const app = new Hono();
app.post('/mcp', c => mcp.handleHttp(c.req.raw));

serve({ fetch: app.fetch, port: 3400 });
console.log('Stateless MCP server on http://localhost:3400/mcp');
