/**
 * Hello-world MCP server (Express). Shown two equivalent ways:
 *
 *   1. The existing v1/v2 pattern — `connect(transport)` + `transport.handleRequest`.
 *      Works unchanged in the rebuild.
 *   2. The new direct pattern — `mcp.handleHttp(req)` with no transport instance.
 *
 * Both produce identical wire behavior. Pick one.
 *
 * Run: npx tsx examples/server/src/helloStatelessExpress.ts
 */
import { randomUUID } from 'node:crypto';

import express from 'express';
import { z } from 'zod/v4';

import { NodeStreamableHTTPServerTransport, toNodeHttpHandler } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';

const mcp = new McpServer({ name: 'hello-express', version: '1.0.0' });

mcp.registerTool(
    'greet',
    { description: 'Say hello', inputSchema: z.object({ name: z.string() }) },
    async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}!` }] })
);

const app = express();

// ─── Way 1: existing v1/v2 pattern (unchanged) ─────────────────────────────
const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
await mcp.connect(transport);
app.all('/mcp-v1style', express.json(), (req, res) => transport.handleRequest(req, res, req.body));

// ─── Way 2: new direct pattern (no connect, no transport instance) ─────────
// Don't pre-parse the body — handleHttp reads it from the raw Request.
app.post('/mcp', toNodeHttpHandler(req => mcp.handleHttp(req)));

app.listen(3400, () => console.log('Express MCP server on :3400 — /mcp (new) and /mcp-v1style (existing)'));
