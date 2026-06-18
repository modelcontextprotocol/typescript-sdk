/**
 * Tools primitive — start here.
 *
 * Register tools with `McpServer.registerTool`: typed input via any
 * Standard-Schema-with-JSON library (Zod here), inferred output schema +
 * `structuredContent` from `outputSchema`, `annotations` for behavioral hints
 * (`readOnlyHint`, `destructiveHint`). One binary, either transport.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { runServerFromArgs } from '../harness.js';

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
            annotations: { readOnlyHint: true, idempotentHint: true }
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

// runServerFromArgs is the example harness's transport selector (default stdio, --http for HTTP). In your own server you'd call serveStdio(buildServer) or createMcpHandler(buildServer) directly.
runServerFromArgs(buildServer);
