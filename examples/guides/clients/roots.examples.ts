/**
 * Companion example for `docs/clients/roots.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness below the
 * regions connects an in-memory server that requests `roots/list` and produces
 * the output the page quotes verbatim.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/clients/roots.examples.ts        # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
//#region roots_capability
import { Client } from '@modelcontextprotocol/client';

const client = new Client(
    { name: 'workspace-client', version: '1.0.0' },
    { capabilities: { roots: { listChanged: true } } }
);
//#endregion roots_capability

//#region roots_listHandler
const roots = [
    { uri: 'file:///home/user/projects/my-app', name: 'My App' },
    { uri: 'file:///home/user/data', name: 'Data' }
];

client.setRequestHandler('roots/list', async () => {
    return { roots };
});
//#endregion roots_listHandler

// ---------------------------------------------------------------------------
// Harness (not shown on the page). An in-memory low-level Server plays the
// counterpart: it requests `roots/list`, and requests it again when the client
// sends `notifications/roots/list_changed`. Any MCP server behaves the same.
// Imported dynamically so the page's lead region stays self-contained.
// ---------------------------------------------------------------------------

const { Server } = await import('@modelcontextprotocol/server');
const { InMemoryTransport } = await import('@modelcontextprotocol/client');

const server = new Server({ name: 'roots-docs-harness', version: '1.0.0' });

const relisted = new Promise<void>(resolve => {
    server.setNotificationHandler('notifications/roots/list_changed', async () => {
        console.log((await server.listRoots()).roots);
        resolve();
    });
});

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

// "Answer roots/list" — the list the page quotes.
console.log((await server.listRoots()).roots);

// "Tell the server when the roots change" — the notification triggers the
// harness's re-list above, whose output the page quotes.
//#region roots_listChanged
roots.push({ uri: 'file:///home/user/projects/another-app', name: 'Another app' });
await client.sendRootsListChanged();
//#endregion roots_listChanged

await relisted;
await client.close();
await server.close();
