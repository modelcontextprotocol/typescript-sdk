/**
 * Tools primitive — start here.
 *
 * Register tools with `McpServer.registerTool`: typed input via any
 * Standard-Schema-with-JSON library (Zod here), inferred output schema +
 * `structuredContent` from `outputSchema`, `annotations` for behavioral hints
 * (`readOnlyHint`, `destructiveHint`). One binary, either transport.
 */
import { serve } from '@hono/node-server';
import { parseExampleArgs } from '@mcp-examples/shared';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

function buildServer(): McpServer {
    const server = new McpServer({ name: 'tools-example', version: '1.0.0' });

    // A read-only tool with typed input and inferred structured output.
    server.registerTool(
        'calc',
        {
            title: 'Calculator',
            description: 'Apply an arithmetic operation to two numbers',
            inputSchema: z.object({
                op: z.enum(['add', 'sub', 'mul']).describe('the operation to apply'),
                a: z.number().describe('left operand'),
                b: z.number().describe('right operand')
            }),
            outputSchema: z.object({ op: z.string(), result: z.number() }),
            annotations: { readOnlyHint: true, idempotentHint: true },
            // Icons a client may render in its UI. `src` is required;
            // `mimeType`, `sizes`, and `theme` are optional hints.
            icons: [{ src: 'https://example.test/calc.svg', mimeType: 'image/svg+xml', sizes: ['any'] }]
        },
        async ({ op, a, b }) => {
            const result = op === 'add' ? a + b : op === 'sub' ? a - b : a * b;
            const structuredContent = { op, result };
            return { content: [{ type: 'text', text: `${a} ${op} ${b} = ${result}` }], structuredContent };
        }
    );

    // A plain string-returning tool (no structuredContent).
    server.registerTool(
        'echo',
        { description: 'Echoes the input', inputSchema: z.object({ text: z.string() }) },
        async ({ text }): Promise<CallToolResult> => ({ content: [{ type: 'text', text }] })
    );

    return server;
}

const { transport, port } = parseExampleArgs();

if (transport === 'stdio') {
    void serveStdio(buildServer);
    console.error('[server] serving over stdio');
} else {
    const handler = createMcpHandler(buildServer);
    // `createMcpHonoApp()` binds the endpoint behind localhost host/origin
    // validation by default, matching the framework factories' defaults.
    const app = createMcpHonoApp();
    app.all('/mcp', c => handler.fetch(c.req.raw));
    serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
        console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
    });
}
