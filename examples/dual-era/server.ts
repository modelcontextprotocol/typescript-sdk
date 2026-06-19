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
 * One binary, either transport (selected by the shared `runServerFromArgs`
 * scaffold from argv): stdio by default (`serveStdio(factory)`), or HTTP
 * under `--http --port <N>` (`createMcpHandler(factory)` on its default
 * posture — modern served per request, 2025-era traffic served stateless from
 * the same factory).
 */
import type { CallToolResult, McpRequestContext } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { runServerFromArgs } from '../harness.js';

const buildServer = (ctx: McpRequestContext) => {
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

// runServerFromArgs is the example harness's transport selector (default stdio, --http for HTTP). In your own server you'd call serveStdio(buildServer) or createMcpHandler(buildServer) directly.
runServerFromArgs(buildServer);
