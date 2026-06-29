/**
 * Transport entry point for the "todos" reference server (the application itself lives in
 * todos.ts). Same dual-transport skeleton as every other example: stdio by default
 * (cli-client spawns it as a child process), Streamable HTTP behind `--http`.
 */
import { createServer } from 'node:http';

import { parseExampleArgs } from '@mcp-examples/shared';
import { toNodeHandler } from '@modelcontextprotocol/node';
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
    createServer(toNodeHandler(handler)).listen(port, () => {
        console.error(`[todos] listening on http://127.0.0.1:${port}/mcp`);
    });
}
