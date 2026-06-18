/**
 * Dual-era HTTP serving with `createMcpHandler`: one factory, one endpoint,
 * both protocol eras.
 *
 * The same factory backs both legacy postures; the `MCP_LEGACY_MODE`
 * environment variable selects how 2025-era (non-envelope) traffic is handled:
 *
 * - unset / `MCP_LEGACY_MODE=stateless` → (the entry's default) 2025-era
 *                                 traffic is served per-request via the
 *                                 stateless idiom from the same factory.
 * - `MCP_LEGACY_MODE=reject`    → modern-only strict: 2026-07-28 requests are
 *                                 served, 2025-era requests get the documented
 *                                 rejection naming the supported revisions.
 *
 * To keep an existing sessionful 2025 deployment serving legacy traffic next
 * to a strict endpoint, route in user land with the exported `isLegacyRequest`
 * predicate in front of a `legacy: 'reject'` handler (see the createMcpHandler
 * section of docs/migration.md for the pattern) — there is no handler-valued
 * `legacy` option.
 *
 * Run with `tsx examples/server/src/dualEraStreamableHttp.ts`, then point any
 * plain 2025 client at http://localhost:3000/mcp (served through the legacy
 * fallback unless `reject` is selected). A `versionNegotiation: { mode: 'auto' }`
 * client negotiates 2026-07-28 against the same endpoint, but automatic
 * envelope emission for every request is still a client-side follow-up:
 * ordinary typed calls (for example `callTool`) must attach the per-request
 * `_meta` envelope explicitly for now (see
 * `test/integration/test/server/createMcpHandler.test.ts` for the pattern),
 * or the endpoint rejects them on the header/body cross-check.
 */
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import type { CallToolResult, CreateMcpHandlerOptions, McpRequestContext } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import * as z from 'zod/v4';

// One factory for both legs (and both postures): tools are defined once and
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
if (legacyMode === 'reject') {
    // Modern-only strict: turn the default stateless legacy fallback off.
    options.legacy = 'reject';
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
