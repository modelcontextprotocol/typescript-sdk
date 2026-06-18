/**
 * In-flight channels: progress, logging, cancellation.
 *
 * The `countdown` tool emits a `notifications/progress` per step (when the
 * call carried a `_meta.progressToken`), a logging notification per step
 * (when the server has the `logging` capability), and stops promptly when the
 * client cancels (`ctx.mcpReq.signal.aborted`). One binary, either transport.
 */
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { runServerFromArgs } from '../harness.js';

function buildServer(): McpServer {
    const server = new McpServer({ name: 'streaming-example', version: '1.0.0' }, { capabilities: { logging: {} } });

    server.registerTool(
        'countdown',
        {
            description: 'Counts down from N, emitting progress + log per step; stops on cancellation',
            inputSchema: z.object({ n: z.number().int().min(1).max(50), delayMs: z.number().int().min(0).default(50) }),
            outputSchema: z.object({ completed: z.number(), total: z.number(), cancelled: z.boolean() })
        },
        async ({ n, delayMs }, ctx) => {
            const progressToken = ctx.mcpReq._meta?.progressToken;
            let completed = 0;
            for (let i = 0; i < n; i++) {
                if (ctx.mcpReq.signal.aborted) break;
                await new Promise(r => setTimeout(r, delayMs));
                completed++;
                if (progressToken !== undefined) {
                    await ctx.mcpReq.notify({
                        method: 'notifications/progress',
                        params: { progressToken, progress: completed, total: n, message: `step ${completed}/${n}` }
                    });
                }
                // Send the log message as a request-tied notification so it
                // rides the same response stream as the progress notification
                // (the connection-level `ctx.mcpReq.log` shorthand sends an
                // unrelated notification, which a per-request HTTP entry
                // cannot deliver mid-call).
                await ctx.mcpReq.notify({
                    method: 'notifications/message',
                    params: { level: 'info', logger: 'countdown', data: `countdown step ${completed}/${n}` }
                });
            }
            const structuredContent = { completed, total: n, cancelled: ctx.mcpReq.signal.aborted };
            return {
                content: [{ type: 'text', text: `completed ${completed}/${n}${structuredContent.cancelled ? ' (cancelled)' : ''}` }],
                structuredContent
            };
        }
    );

    return server;
}

runServerFromArgs(buildServer);
