/**
 * Companion example for `docs/clients/subscriptions.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness drives a
 * `createMcpHandler` entry in process — no port, no socket — over a
 * 2026-07-28 connection, publishes the changes, and produces the output the
 * page quotes verbatim. It exits non-zero if a quoted line never appears.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/clients/subscriptions.examples.ts   # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

// ---------------------------------------------------------------------------
// Harness server (not shown on the page). A per-request factory whose tool
// set and `config://app` resource the harness mutates between publishes.
// `subscriptions/listen` is served by the entry, so the page's client talks
// to `handler.fetch` directly — the URL is never dialed.
// ---------------------------------------------------------------------------

let settings = { theme: 'light' };
let archiveEnabled = false;

function buildNotesServer(): McpServer {
    const server = new McpServer(
        { name: 'notes', version: '1.0.0' },
        { capabilities: { tools: { listChanged: true }, resources: { subscribe: true } } }
    );
    server.registerTool(
        'search-notes',
        { description: 'Search notes', inputSchema: z.object({ query: z.string() }) },
        async ({ query }) => ({
            content: [{ type: 'text', text: `no notes match ${query}` }]
        })
    );
    if (archiveEnabled) {
        server.registerTool('archive-note', { description: 'Archive a note' }, async () => ({
            content: [{ type: 'text', text: 'archived' }]
        }));
    }
    server.registerResource('config', 'config://app', { mimeType: 'application/json' }, async uri => ({
        contents: [{ uri: uri.href, text: JSON.stringify(settings) }]
    }));
    return server;
}

// Each leg gets its own handler instance (and therefore its own event bus),
// so a publish meant for one leg cannot reach the other.
const handler = createMcpHandler(buildNotesServer);
const autoHandler = createMcpHandler(buildNotesServer);

/** Connect `client` to `target` over the 2026-07-28 revision, in process. */
async function connect(client: Client, target: typeof handler): Promise<void> {
    client.setVersionNegotiation({ mode: 'auto' });
    await client.connect(
        new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
            fetch: (url, init) => target.fetch(new Request(url, init))
        })
    );
}

// Every `console.log` line is also recorded so the harness can wait for the
// exact output the page quotes (and fail loudly if it never arrives).
const logged: string[] = [];
const realLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
    realLog(...args);
};
/** Wait until a logged line starts with `prefix`, or throw after 5 s. */
async function loggedLine(prefix: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!logged.some(line => line.startsWith(prefix))) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for output line "${prefix}"`);
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}

const client = new Client({ name: 'notes-watcher', version: '1.0.0' });
await connect(client, handler);

// ---------------------------------------------------------------------------
// "Open a subscription stream" — the honored-filter line the page quotes.
// ---------------------------------------------------------------------------

//#region listen_open
client.setNotificationHandler('notifications/tools/list_changed', async () => {
    const { tools } = await client.listTools();
    console.log('Tools changed:', tools.length);
});

const subscription = await client.listen({
    toolsListChanged: true,
    resourceSubscriptions: ['config://app']
});
console.log('Server honored:', subscription.honoredFilter);
//#endregion listen_open

// ---------------------------------------------------------------------------
// "Handle the notifications" — the second handler, then one publish of each
// kind. Both notification lines the page quotes come from these handlers.
// ---------------------------------------------------------------------------

//#region listen_updated
client.setNotificationHandler('notifications/resources/updated', async notification => {
    const { contents } = await client.readResource({ uri: notification.params.uri });
    console.log('Updated', notification.params.uri, contents);
});
//#endregion listen_updated

archiveEnabled = true;
handler.notify.toolsChanged();
await loggedLine('Tools changed:');

settings = { theme: 'dark' };
handler.notify.resourceUpdated('config://app');
await loggedLine('Updated config://app');

// ---------------------------------------------------------------------------
// "Close the stream and react to closure" — the close reason the page quotes.
// ---------------------------------------------------------------------------

//#region listen_close
await subscription.close();
console.log('Closed:', await subscription.closed);
//#endregion listen_close

await client.close();
await handler.close();

/** Example: re-listen only on an unexpected disconnect. Never invoked — the page's watch-loop block. */
async function watchConfig(watching: boolean): Promise<void> {
    //#region listen_watchLoop
    while (watching) {
        const sub = await client.listen({ resourceSubscriptions: ['config://app'] });
        const reason = await sub.closed;
        if (reason !== 'remote') break; // 'local' or 'graceful': done
        await new Promise(resolve => setTimeout(resolve, 1000)); // back off, then re-listen
    }
    //#endregion listen_watchLoop
}
void watchConfig;

// ---------------------------------------------------------------------------
// "Let the SDK open the stream for you" — a second client whose stream the
// SDK opens from the `listChanged` option. The harness publishes one more
// tool change to produce the `onChanged` line the page quotes.
// ---------------------------------------------------------------------------

//#region listChanged_auto
const watcher = new Client(
    { name: 'notes-watcher', version: '1.0.0' },
    {
        listChanged: {
            tools: {
                onChanged: (error, tools) => {
                    if (error) {
                        console.error('Refresh failed:', error);
                        return;
                    }
                    console.log('Tools refreshed:', tools?.length);
                }
            }
        }
    }
);
//#endregion listChanged_auto

await connect(watcher, autoHandler);
if (watcher.autoOpenedSubscription === undefined) {
    throw new Error('listChanged should auto-open a subscription stream on a 2026-07-28 connection');
}
console.log('Auto-opened:', watcher.autoOpenedSubscription.honoredFilter);

archiveEnabled = false;
autoHandler.notify.toolsChanged();
await loggedLine('Tools refreshed:');

await watcher.autoOpenedSubscription.close();
await watcher.close();
await autoHandler.close();

/** Example: the 2025-era per-resource path. Never invoked — `resources/subscribe` is not part of 2026-07-28. */
async function legacySubscribe(client: Client): Promise<void> {
    //#region subscribeResource_legacy
    await client.subscribeResource({ uri: 'config://app' });

    // The same notifications/resources/updated handler fires.

    await client.unsubscribeResource({ uri: 'config://app' });
    //#endregion subscribeResource_legacy
}
void legacySubscribe;
