/**
 * Dual-era serving from one factory, both transports.
 *
 * The same factory backs both protocol eras: a 2025-era client connects with
 * the `initialize` handshake; a 2026-capable client
 * (`versionNegotiation: { mode: 'auto' }`) probes with `server/discover`,
 * negotiates the 2026-07-28 revision, and the SDK attaches the per-request
 * `_meta` envelope to every outgoing request itself. Tools are defined once
 * and served identically to either kind of client.
 *
 * One binary, either transport (selected from argv): stdio by default
 * (`serveStdio(buildServer)`), or HTTP under `--http --port <N>`
 * (`createMcpHandler(buildServer)` on its default posture — modern served per
 * request, 2025-era traffic served stateless from the same factory).
 */
import { createServer } from 'node:http';

import { parseExampleArgs } from '@mcp-examples/shared';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { CallToolResult, McpRequestContext } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const buildServer = (ctx: McpRequestContext): McpServer => {
    const server = new McpServer(
        { name: 'dual-era-server', version: '1.0.0' },
        { capabilities: { tools: {} }, instructions: 'A small dual-era demo server.' }
    );

    server.registerTool(
        'greet',
        {
            description: 'Greets the caller and reports which protocol era served the request',
            inputSchema: z.object({ name: z.string().describe('Name to greet') })
        },
        async ({ name }): Promise<CallToolResult> => ({
            content: [{ type: 'text', text: `Hello, ${name}! (served on the ${ctx.era} protocol era)` }]
        })
    );

    return server;
};

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
