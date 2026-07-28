/**
 * Prompts primitive + completion.
 *
 * Register prompts with `McpServer.registerPrompt`; wrap an arg schema with
 * `completable(...)` so the client's `complete()` call returns suggestions.
 * One binary, either transport.
 */
import { serve } from '@hono/node-server';
import { parseExampleArgs } from '@mcp-examples/shared';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { completable, createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const LANGUAGES = ['python', 'typescript', 'rust', 'go'];

function buildServer(): McpServer {
    const server = new McpServer({ name: 'prompts-example', version: '1.0.0' });

    server.registerPrompt(
        'review-code',
        {
            title: 'Code review',
            description: 'Review code for quality and idioms',
            argsSchema: z.object({
                language: completable(z.string().describe('Programming language'), value => LANGUAGES.filter(l => l.startsWith(value))),
                code: z.string().describe('The code to review')
            })
        },
        async ({ language, code }) => ({
            messages: [
                {
                    role: 'user',
                    content: { type: 'text', text: `Review this ${language} code for quality and idioms:\n\n${code}` }
                }
            ]
        })
    );

    return server;
}

const { transport, port } = parseExampleArgs();

if (transport === 'stdio') {
    void serveStdio(buildServer);
    console.error('[server] serving over stdio');
} else {
    const handler = createMcpHandler(buildServer);
    // `createMcpHonoApp()` arms localhost host/origin validation by default; bind loopback explicitly to match.
    const app = createMcpHonoApp();
    app.all('/mcp', c => handler.fetch(c.req.raw));
    serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
        console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
    });
}
