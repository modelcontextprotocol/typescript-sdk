/**
 * `subscriptions/listen` change notifications served via `createMcpHandler`
 * (protocol revision 2026-07-28).
 *
 * The handler exposes `.notify` typed publish sugar over its
 * `subscriptions/listen` bus: this example calls
 * `handler.notify.toolsChanged()` whenever a tool is added or removed, and
 * every open `subscriptions/listen` stream that opted in to
 * `toolsListChanged` receives a stamped `notifications/tools/list_changed`.
 *
 * Run with:
 *
 *     tsx examples/server/src/subscriptionsListen.ts
 *
 * and point the paired client example at it:
 *
 *     tsx examples/client/src/subscriptionsListenClient.ts
 */
import { createServer } from 'node:http';

import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

let extraToolEnabled = false;

function buildServer(): McpServer {
    const server = new McpServer({ name: 'subscriptions-listen-example', version: '1.0.0' });

    server.registerTool('greet', { description: 'Returns a greeting', inputSchema: z.object({ name: z.string() }) }, async ({ name }) => ({
        content: [{ type: 'text', text: `hello, ${name}` }]
    }));
    if (extraToolEnabled) {
        server.registerTool(
            'farewell',
            { description: 'Returns a farewell', inputSchema: z.object({ name: z.string() }) },
            async ({ name }) => ({ content: [{ type: 'text', text: `goodbye, ${name}` }] })
        );
    }

    return server;
}

// Host with the per-request HTTP entry on its default posture (2026-07-28
// served per request; 2025-era traffic served stateless from the same
// factory). The handler creates an in-process bus by default; supply your
// own `bus` for multi-process deployments.
const handler = createMcpHandler(() => buildServer());
const port = Number(process.env.PORT ?? '3000');

createServer((req, res) => void handler.node(req, res)).listen(port, () => {
    console.error(`subscriptions/listen example server listening on http://localhost:${port}/`);
});

// Mutate the tool set every two seconds and publish the change to every open
// subscription stream that opted in to toolsListChanged. Safe to call when no
// subscription is open (no-op).
setInterval(() => {
    extraToolEnabled = !extraToolEnabled;
    console.error(`tools changed: farewell ${extraToolEnabled ? 'added' : 'removed'}`);
    handler.notify.toolsChanged();
}, 2000);
