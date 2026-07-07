/**
 * Transport entry point for the "todos" reference server (the application itself lives in
 * todos.ts). Same dual-transport skeleton as every other example: stdio by default
 * (cli-client spawns it as a child process), Streamable HTTP behind `--http`.
 */
import { serve } from '@hono/node-server';
import { parseExampleArgs } from '@mcp-examples/shared';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler, InMemoryServerEventBus } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createTodosApp } from './todos';

const { transport, port } = parseExampleArgs();

// One process, one board. The key comes from the environment for real deployments and falls
// back to a per-process random one for the zero-setup demo (fine: one process serves every
// round of a multi-round flow).
if (transport === 'stdio') {
    // Single connection, no bus: the app announces on the pinned instance and the entry
    // routes that onto its open subscriptions/listen streams.
    const app = createTodosApp({ requestStateKey: process.env.REQUEST_STATE_SECRET });
    void serveStdio(app.buildServer);
    console.error('[todos] serving over stdio');
} else {
    // Per-request serving has no connection to push notifications down — the app announces
    // on the bus and the handler routes the events onto its subscriptions/listen streams.
    const bus = new InMemoryServerEventBus();
    const app = createTodosApp({ requestStateKey: process.env.REQUEST_STATE_SECRET, bus });
    const handler = createMcpHandler(app.buildServer, { bus });
    // `createMcpHonoApp()` binds the endpoint behind localhost host/origin
    // validation by default, matching the framework factories' defaults.
    const honoApp = createMcpHonoApp();
    honoApp.all('/mcp', c => handler.fetch(c.req.raw));
    serve({ fetch: honoApp.fetch, port, hostname: '127.0.0.1' }, () => {
        console.error(`[todos] listening on http://127.0.0.1:${port}/mcp`);
    });
}
