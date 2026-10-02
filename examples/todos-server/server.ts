/**
 * Transport entry point for the "todos" reference server (the application itself lives in
 * todos.ts). Same dual-transport skeleton as every other example: stdio by default
 * (cli-client spawns it as a child process), Streamable HTTP behind `--http`.
 */
import { serve } from '@hono/node-server';
import { parseExampleArgs } from '@mcp-examples/shared';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { buildServer, onBoardChanged, onBoardUpdated } from './todos';

const { transport, port } = parseExampleArgs();

if (transport === 'stdio') {
    void serveStdio(buildServer);
    console.error('[todos] serving over stdio');
} else {
    const handler = createMcpHandler(buildServer);
    // Per-request serving has no connection to push notifications down — cross-request
    // events (the board changing) are published through the handler's notifier instead.
    onBoardChanged(() => handler.notify.resourcesChanged());
    onBoardUpdated(uri => handler.notify.resourceUpdated(uri));
    // `createMcpHonoApp()` binds the endpoint behind localhost host/origin
    // validation by default, matching the framework factories' defaults.
    const app = createMcpHonoApp();
    app.all('/mcp', c => handler.fetch(c.req.raw));
    serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
        console.error(`[todos] listening on http://127.0.0.1:${port}/mcp`);
    });
}
