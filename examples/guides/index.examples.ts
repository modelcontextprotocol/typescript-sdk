/**
 * Type-checked companion for `docs-v2/index.md` (the landing page).
 *
 * The single region below is the landing hero: a complete MCP server in one
 * block. Imports live inside the region so the rendered block stands alone.
 * Synced into the page by `pnpm sync:snippets`; typecheck-only, never executed.
 *
 * @module
 */

//#region serveStdio_minimal
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

serveStdio(() => {
    const server = new McpServer({ name: 'weather', version: '1.0.0' });

    server.registerTool(
        'get-forecast',
        {
            description: 'Get the weather forecast for a city',
            inputSchema: z.object({ city: z.string() })
        },
        async ({ city }) => ({
            content: [{ type: 'text', text: `Sunny in ${city} all week.` }]
        })
    );

    return server;
});
//#endregion serveStdio_minimal
