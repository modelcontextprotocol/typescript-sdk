/**
 * `subscriptions/listen` change notifications (protocol revision 2026-07-28).
 *
 * One factory, either transport — but the publish surface differs by entry:
 *
 * - **HTTP** (`createMcpHandler`): the handler exposes `.notify`
 *   ({@link ServerNotifier}) over its cross-request {@link ServerEventBus};
 *   `handler.notify.toolsChanged()` reaches every open `subscriptions/listen`
 *   stream that opted in to `toolsListChanged`.
 * - **stdio** (`serveStdio`): one `McpServer` instance is pinned for the
 *   connection; toggling a `RegisteredTool` (`.enable()/.disable()`) emits the
 *   instance's own `notifications/tools/list_changed`, which the stdio entry's
 *   listen router fans onto every open subscription.
 *
 * The `flip_tools` tool toggles the `farewell` tool and publishes the change,
 * so the client decides when to mutate (no timer race with the runner). The
 * canonical-shape transport branch below assigns `publish` per entry.
 */
import { serve } from '@hono/node-server';
import { parseExampleArgs } from '@mcp-examples/shared';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import type { RegisteredTool, ServerEventBus, ServerNotifier } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

let extraToolEnabled = false;
/**
 * Publishes `tools/list_changed` to every open subscription. Assigned by the
 * transport branch below: `handler.notify.toolsChanged()` over HTTP; toggling
 * the pinned instance's `RegisteredTool` over stdio.
 */
let publish: () => void = () => {};

function buildServer(): McpServer {
    const server = new McpServer(
        { name: 'subscriptions-listen-example', version: '1.0.0' },
        { capabilities: { tools: { listChanged: true } } }
    );

    server.registerTool('greet', { description: 'Returns a greeting', inputSchema: z.object({ name: z.string() }) }, async ({ name }) => ({
        content: [{ type: 'text', text: `hello, ${name}` }]
    }));
    const farewell: RegisteredTool = server.registerTool(
        'farewell',
        { description: 'Returns a farewell', inputSchema: z.object({ name: z.string() }) },
        async ({ name }) => ({ content: [{ type: 'text', text: `goodbye, ${name}` }] })
    );
    if (!extraToolEnabled) farewell.disable();

    server.registerTool(
        'flip_tools',
        { description: 'Toggle the farewell tool and publish tools/list_changed to every open subscription' },
        async () => {
            extraToolEnabled = !extraToolEnabled;
            // Over stdio this `update` IS the publish (the entry's listen
            // router fans the instance's outbound list_changed onto every open
            // subscription); over HTTP it just keeps this per-request instance
            // consistent and `publish()` reaches the cross-request bus.
            farewell.update({ enabled: extraToolEnabled });
            publish();
            return { content: [{ type: 'text', text: `farewell ${extraToolEnabled ? 'enabled' : 'disabled'}` }] };
        }
    );

    return server;
}

const { transport, port } = parseExampleArgs();

if (transport === 'stdio') {
    // Over stdio the per-instance `farewell.update` inside `flip_tools` IS the
    // publish, so `publish` stays a no-op here.
    void serveStdio(buildServer);
    console.error('[server] serving over stdio');
} else {
    // Host with the per-request HTTP entry on its default posture. The handler
    // creates an in-process bus by default; supply your own `bus` for
    // multi-process deployments.
    const handler = createMcpHandler(buildServer);
    const bus: ServerEventBus = handler.bus;
    const notify: ServerNotifier = handler.notify;
    void bus; // (the typed publish facade `notify` wraps `bus.publish`)
    publish = () => notify.toolsChanged();
    // `createMcpHonoApp()` arms localhost host/origin validation by default;
    // bind loopback explicitly to match.
    const app = createMcpHonoApp();
    app.all('/mcp', c => handler.fetch(c.req.raw));
    serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
        console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
    });
}
