/**
 * Drives the `subscriptions/listen` server example
 * (`examples/server/src/subscriptionsListen.ts`) two ways on a 2026-07-28
 * connection:
 *
 * 1. **auto-open via `ClientOptions.listChanged`** — the same option a
 *    2025-era client sets; on a modern connection the SDK auto-opens a
 *    listen stream with the filter derived from which sub-options were set,
 *    so the configured `onChanged` handlers fire on every published change;
 * 2. **manual `client.listen()`** — opens a stream explicitly, registers a
 *    `notifications/tools/list_changed` handler the stream feeds, and closes
 *    after a few notifications.
 *
 * Start the server first, then:
 *
 *     tsx examples/client/src/subscriptionsListenClient.ts
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const URL = process.env.MCP_SERVER_URL ?? 'http://localhost:3000/';
const CLIENT_INFO = { name: 'subscriptions-listen-example-client', version: '1.0.0' };

async function autoOpenLeg(): Promise<void> {
    console.log('--- auto-open via ClientOptions.listChanged ---');
    let count = 0;
    let done!: () => void;
    const finished = new Promise<void>(resolve => {
        done = resolve;
    });
    const client = new Client(CLIENT_INFO, {
        versionNegotiation: { mode: 'auto' },
        listChanged: {
            tools: {
                // autoRefresh: false — automatic per-request envelope emission
                // is a client-side follow-up; until then a refreshing
                // listTools() on a 2026 connection needs the envelope attached
                // explicitly (see the multi-round-trip example).
                autoRefresh: false,
                onChanged: () => {
                    console.log('[client] (auto) tools/list_changed received');
                    if (++count >= 2) done();
                }
            }
        }
    });
    await client.connect(new StreamableHTTPClientTransport(new globalThis.URL(URL)));
    console.log(`[client] (auto) connected (${client.getNegotiatedProtocolVersion()}); auto-opened filter:`, client.autoOpenedSubscription?.honoredFilter);
    await finished;
    await client.autoOpenedSubscription?.close();
    await client.close();
}

async function manualLeg(): Promise<void> {
    console.log('--- manual client.listen() ---');
    const client = new Client(CLIENT_INFO, { versionNegotiation: { mode: 'auto' } });
    let count = 0;
    let done!: () => void;
    const finished = new Promise<void>(resolve => {
        done = resolve;
    });
    client.setNotificationHandler('notifications/tools/list_changed', () => {
        console.log('[client] (manual) tools/list_changed received');
        if (++count >= 2) done();
    });
    await client.connect(new StreamableHTTPClientTransport(new globalThis.URL(URL)));
    const sub = await client.listen({ toolsListChanged: true });
    console.log('[client] (manual) listening; honored filter:', sub.honoredFilter);
    await finished;
    await sub.close();
    await client.close();
}

await autoOpenLeg();
await manualLeg();
console.log('done.');
