/**
 * `createMcpHandler` with `responseMode: 'json'` — single JSON response
 * instead of an SSE stream. Useful for serverless deployments that can't
 * hold a stream open. Mid-call notifications are dropped (the handler logs a
 * warning at construction time).
 */
import { createServer } from 'node:http';

import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const handler = createMcpHandler(
    () => {
        const server = new McpServer({ name: 'json-response-example', version: '1.0.0' });
        server.registerTool(
            'greet',
            { description: 'A simple greeting tool', inputSchema: z.object({ name: z.string() }) },
            async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}!` }] })
        );
        return server;
    },
    { responseMode: 'json' }
);

const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
const port = portIdx === -1 ? 3000 : Number(argv[portIdx + 1]);
createServer((req, res) => void handler.node(req, res)).listen(port, () => {
    console.error(`json-response example server listening on http://127.0.0.1:${port}/`);
});
