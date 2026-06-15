/**
 * Dual-era HTTP serving with `createMcpHandler`: one factory, one endpoint,
 * both protocol eras.
 *
 * The same factory backs every serving mode; the `MCP_LEGACY_MODE` environment
 * variable selects how 2025-era (non-envelope) traffic is handled:
 *
 * - `MCP_LEGACY_MODE=none`      → modern-only strict: 2026-07-28 requests are
 *                                 served, 2025-era requests get the documented
 *                                 rejection naming the supported revisions.
 * - `MCP_LEGACY_MODE=stateless` → (default) 2025-era traffic is additionally
 *                                 served per-request via the stateless idiom.
 * - `MCP_LEGACY_MODE=byo`       → the same, but wired explicitly through the
 *                                 exported `legacyStatelessFallback` slot value
 *                                 (stand-in for bringing your own legacy handler,
 *                                 e.g. an existing sessionful wiring).
 *
 * Run with `tsx examples/server/src/dualEraStreamableHttp.ts`, then point a
 * 2026-capable client (`versionNegotiation: { mode: 'auto' }`) or any plain
 * 2025 client at http://localhost:3000/mcp.
 */
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import type { CallToolResult, CreateMcpHandlerOptions, McpRequestContext } from '@modelcontextprotocol/server';
import { createMcpHandler, legacyStatelessFallback, McpServer } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import * as z from 'zod/v4';

// One factory for both legs (and every slot state): tools are defined once and
// served identically to 2025-era and 2026-era clients.
const getServer = (ctx: McpRequestContext) => {
    const server = new McpServer(
        {
            name: 'dual-era-server',
            version: '1.0.0'
        },
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

const legacyMode = process.env.MCP_LEGACY_MODE ?? 'stateless';
const options: CreateMcpHandlerOptions = {
    onerror: error => console.error('MCP handler error:', error.message)
};
if (legacyMode === 'stateless') {
    options.legacy = 'stateless';
} else if (legacyMode === 'byo') {
    // Bring-your-own legacy serving: any fetch-shaped handler works here. The
    // canonical stateless fallback doubles as the simplest BYO value; an
    // existing sessionful streamable HTTP wiring would be passed the same way.
    options.legacy = legacyStatelessFallback(getServer);
}

const handler = createMcpHandler(getServer, options);

// Origin/Host validation is middleware, not entry, concern: the Express app
// factory arms both for localhost binds by default.
const app = createMcpExpressApp();

app.all('/mcp', (req: Request, res: Response) => {
    void handler.node(req, res, req.body);
});

const PORT = 3000;
app.listen(PORT, error => {
    if (error) {
        console.error('Failed to start server:', error);
        // eslint-disable-next-line unicorn/no-process-exit
        process.exit(1);
    }
    console.log(`Dual-era MCP server listening on http://localhost:${PORT}/mcp (legacy mode: ${legacyMode})`);
});

process.on('SIGINT', async () => {
    await handler.close();
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(0);
});
