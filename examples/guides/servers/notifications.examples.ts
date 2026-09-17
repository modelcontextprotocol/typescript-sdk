/**
 * Companion example for `docs/servers/notifications.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness below the
 * lead region connects an in-memory client whose notification log the page
 * quotes verbatim.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/servers/notifications.examples.ts   # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
//#region notifications_server
import { McpServer } from '@modelcontextprotocol/server';

const jobs = ['nightly-backup'];

const server = new McpServer({ name: 'jobs', version: '1.0.0' });

server.registerTool('list-jobs', { description: 'List the configured jobs' }, async () => ({
    content: [{ type: 'text', text: jobs.join('\n') }]
}));
//#endregion notifications_server

// Symbols the later sections use, imported here so the page's lead block shows
// only what it teaches. A real server imports everything in one statement.
import { createMcpHandler, InMemoryServerEventBus, Server } from '@modelcontextprotocol/server';

// ---------------------------------------------------------------------------
// Harness (not shown on the page). An in-memory client connected to the server
// above logs every list-changed notification it receives — the output the
// page quotes verbatim. Any MCP client behaves the same.
// ---------------------------------------------------------------------------

const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');

const client = new Client({ name: 'notifications-docs-harness', version: '1.0.0' });
for (const method of [
    'notifications/tools/list_changed',
    'notifications/prompts/list_changed',
    'notifications/resources/list_changed'
] as const) {
    client.setNotificationHandler(method, async () => console.log(method));
}

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

// "Send a list-changed notification" — the explicit push the page quotes.
//#region sendToolListChanged_basic
server.sendToolListChanged();
//#endregion sendToolListChanged_basic

// A round-trip so the notification above flushes before the next region runs;
// the page quotes its single output line on its own.
await client.listTools();

// "Let registration changes notify for you" — three more sends, none explicit.
//#region registeredTool_update
const report = server.registerTool('run-report', { description: 'Run the weekly report' }, async () => ({
    content: [{ type: 'text', text: 'report queued' }]
}));

report.update({ description: 'Run the weekly report and email it' });
report.disable();
//#endregion registeredTool_update

await client.listTools();
await client.close();
await server.close();

// ---------------------------------------------------------------------------
// "Advertise the listChanged capability" — the low-level Server needs it
// declared up front. Constructed only; nothing on the page quotes output here.
// ---------------------------------------------------------------------------

//#region Server_listChanged
const lowLevel = new Server({ name: 'jobs', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
//#endregion Server_listChanged
void lowLevel;

// ---------------------------------------------------------------------------
// "Publish a resource update through the handler". The factory the page refers
// to: a fresh McpServer per request, advertising `resources.subscribe` so the
// entry honors per-resource subscriptions.
// ---------------------------------------------------------------------------

function buildJobsServer(): McpServer {
    const app = new McpServer({ name: 'jobs', version: '1.0.0' }, { capabilities: { resources: { subscribe: true } } });
    app.registerResource('config', 'config://app', { mimeType: 'application/json' }, async uri => ({
        contents: [{ uri: uri.href, text: JSON.stringify({ jobs }) }]
    }));
    return app;
}

// Runs as written: with no subscription stream open the publish is a no-op,
// and `createMcpHandler` binds no port.
//#region handler_notifyResourceUpdated
const handler = createMcpHandler(() => buildJobsServer());

// After config://app changes:
handler.notify.resourceUpdated('config://app');
//#endregion handler_notifyResourceUpdated

await handler.close();

// "Pick an event bus for multi-process deployments" — typecheck-only wrapper.
function createMcpHandler_bus() {
    //#region createMcpHandler_bus
    const bus = new InMemoryServerEventBus();

    const shared = createMcpHandler(() => buildJobsServer(), { bus });
    //#endregion createMcpHandler_bus
    return shared;
}
void createMcpHandler_bus;
