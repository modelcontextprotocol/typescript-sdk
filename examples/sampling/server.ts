/**
 * Sampling — a tool that asks the host LLM for a completion. One factory,
 * both protocol eras.
 *
 * The same tool serves both eras with different APIs: on a 2025-era
 * connection (`--legacy`, the `initialize` handshake) the server uses the
 * push-style server→client request flow — `ctx.mcpReq.requestSampling(...)`
 * sends `sampling/createMessage` and awaits the answer in-line. On a
 * 2026-07-28 connection there is no server→client request channel: the same
 * tool instead **returns** `inputRequired(...)` with an embedded
 * `sampling/createMessage`, and the client retries with the model's response
 * attached. The protocol carries the request differently; the user
 * experience is the same.
 *
 * One binary, either transport. Logs go to stderr only — stdio's stdout is
 * the JSON-RPC stream.
 */
import { createServer } from 'node:http';

import { parseExampleArgs } from '@mcp-examples/shared';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { CallToolResult, InputRequiredResult, McpRequestContext } from '@modelcontextprotocol/server';
import { createMcpHandler, inputRequired, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

function buildServer(reqCtx: McpRequestContext): McpServer {
    const server = new McpServer({ name: 'sampling-example', version: '1.0.0' });

    server.registerTool(
        'summarize',
        { description: 'Summarize text using the host LLM', inputSchema: z.object({ text: z.string() }) },
        async ({ text }, ctx): Promise<CallToolResult | InputRequiredResult> => {
            const messages = [
                {
                    role: 'user' as const,
                    content: { type: 'text' as const, text: `Please summarize the following text concisely:\n\n${text}` }
                }
            ];
            if (reqCtx.era === 'legacy') {
                // 2025-era: push a server→client `sampling/createMessage` request
                // and await the model's answer in-line.
                const response = await ctx.mcpReq.requestSampling({ messages, maxTokens: 500 });
                // `content` is a single block when no tools were passed.
                const content = response.content;
                const summary = !Array.isArray(content) && content.type === 'text' ? content.text : 'Unable to generate summary';
                return { content: [{ type: 'text', text: summary }] };
            }
            // 2026-07-28: return inputRequired with an embedded
            // `sampling/createMessage` — the client's auto-fulfilment driver
            // dispatches it to the same `sampling/createMessage` handler and
            // retries this call with the model's response attached.
            const response = ctx.mcpReq.inputResponses?.['summary'] as { content?: { type: string; text?: string } } | undefined;
            if (!response) {
                return inputRequired({
                    inputRequests: { summary: inputRequired.createMessage({ messages, maxTokens: 500 }) }
                });
            }
            const summary = response.content?.type === 'text' ? (response.content.text ?? '') : 'Unable to generate summary';
            return { content: [{ type: 'text', text: summary }] };
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
