/**
 * One notification-emitting tool that the parallel-calls client drives with
 * multiple concurrent clients (HTTP) or one client / multiple concurrent
 * calls (both transports), asserting in-flight notifications are attributed
 * back to the right caller. One binary, either transport.
 */
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { runServerFromArgs } from '../harness.js';

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

// runServerFromArgs is the example harness's transport selector (default stdio, --http for HTTP). In your own server you'd call serveStdio(buildServer) or createMcpHandler(buildServer) directly.
runServerFromArgs(buildServer);
