/**
 * A small `createMcpHandler` server with one notification-emitting tool, used
 * by the parallel-calls client to drive multiple concurrent clients / parallel
 * tool calls and attribute notifications back to their caller. HTTP-only.
 */
import { createServer } from 'node:http';

import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'parallel-calls-example', version: '1.0.0' }, { capabilities: { logging: {} } });
    server.registerTool(
        'start-notification-stream',
        {
            description: 'Sends a few periodic logging notifications tagged with the caller id',
            inputSchema: z.object({ caller: z.string(), count: z.number().int().min(1).max(20).default(3) })
        },
        async ({ caller, count }, ctx) => {
            for (let i = 1; i <= count; i++) {
                // Send as a request-tied notification so it rides the same SSE
                // stream as the eventual result.
                await ctx.mcpReq.notify({
                    method: 'notifications/message',
                    params: { level: 'info', data: `[${caller}] tick ${i}/${count}` }
                });
                await new Promise(r => setTimeout(r, 20));
            }
            return { content: [{ type: 'text', text: `[${caller}] done (${count})` }] };
        }
    );
    return server;
});

const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
const port = portIdx === -1 ? 3000 : Number(argv[portIdx + 1]);
createServer((req, res) => void handler.node(req, res)).listen(port, () => {
    console.error(`parallel-calls example server listening on http://127.0.0.1:${port}/`);
});
