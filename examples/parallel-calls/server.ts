/**
 * One notification-emitting tool that the parallel-calls client drives with
 * multiple concurrent clients (HTTP) or one client / multiple concurrent
 * calls (both transports), asserting in-flight notifications are attributed
 * back to the right caller. One binary, either transport.
 */
import { createServer } from 'node:http';

import { parseExampleArgs } from '@mcp-examples/shared';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

function buildServer(): McpServer {
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
}

const { transport, port } = parseExampleArgs();

if (transport === 'stdio') {
    void serveStdio(buildServer);
    console.error('[server] serving over stdio');
} else {
    const handler = createMcpHandler(buildServer);
    createServer(toNodeHandler(handler)).listen(port, () => {
        console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
    });
}
