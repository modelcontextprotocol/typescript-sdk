/**
 * Stateless hello-world MCP server. No connect(), no transport instance —
 * one McpServer at module scope, handleHttp() per request.
 *
 * Run: npx tsx examples/server/src/helloStateless.ts
 */
import { createServer } from 'node:http';

import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

const mcp = new McpServer({ name: 'hello-stateless', version: '1.0.0' });

mcp.registerTool(
    'greet',
    { description: 'Say hello', inputSchema: z.object({ name: z.string() }) },
    async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}!` }] })
);

createServer(async (req, res) => {
    if (req.url !== '/mcp' || req.method !== 'POST') {
        res.writeHead(404).end();
        return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const webReq = new Request(`http://localhost${req.url}`, {
        method: 'POST',
        headers: req.headers as Record<string, string>,
        body: Buffer.concat(chunks)
    });

    const webRes = await mcp.handleHttp(webReq);

    res.writeHead(webRes.status, Object.fromEntries(webRes.headers));
    if (webRes.body) {
        for await (const chunk of webRes.body) res.write(chunk);
    }
    res.end();
}).listen(3400, () => console.log('Stateless MCP server on http://localhost:3400/mcp'));
