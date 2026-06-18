/**
 * The minimal `createMcpHandler` deployment, on its default posture.
 *
 * One factory, one endpoint: 2026-07-28 traffic is served per request, and
 * 2025-era (non-envelope) traffic is served stateless from the same factory
 * (`legacy: 'stateless'`, the default). This replaces the hand-wired
 * "new transport + new server per POST" stateless idiom of the 1.x SDK with
 * a one-liner.
 */
import { createServer } from 'node:http';

import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'stateless-legacy-example', version: '1.0.0' }, { capabilities: { logging: {} } });
    server.registerTool(
        'greet',
        { description: 'A simple greeting tool', inputSchema: z.object({ name: z.string() }) },
        async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}!` }] })
    );
    return server;
});

const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
const port = portIdx === -1 ? 3000 : Number(argv[portIdx + 1]);
createServer(toNodeHandler(handler)).listen(port, () => {
    console.error(`stateless-legacy example server listening on http://127.0.0.1:${port}/`);
});
