/**
 * A tool that requests LLM sampling from the client via
 * `ctx.mcpReq.requestSampling(...)` (the request-context idiom — replaces the
 * older `mcpServer.server.createMessage(...)`). One binary, either transport.
 *
 * Logs go to stderr only — stdio's stdout is the JSON-RPC stream.
 */
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { runServerFromArgs } from '../harness.js';

function buildServer(): McpServer {
    const server = new McpServer({ name: 'sampling-example', version: '1.0.0' });

    server.registerTool(
        'summarize',
        { description: 'Summarize text using the host LLM', inputSchema: z.object({ text: z.string() }) },
        async ({ text }, ctx) => {
            const response = await ctx.mcpReq.requestSampling({
                messages: [{ role: 'user', content: { type: 'text', text: `Please summarize the following text concisely:\n\n${text}` } }],
                maxTokens: 500
            });
            // `content` is a single block when no tools were passed.
            const content = response.content;
            const summary = !Array.isArray(content) && content.type === 'text' ? content.text : 'Unable to generate summary';
            return { content: [{ type: 'text', text: summary }] };
        }
    );

    return server;
}

// runServerFromArgs is the example harness's transport selector (default stdio, --http for HTTP). In your own server you'd call serveStdio(buildServer) or createMcpHandler(buildServer) directly.
runServerFromArgs(buildServer);
