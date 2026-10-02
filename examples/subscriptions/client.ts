/**
 * Drives the `subscriptions/listen` server (`./server.ts`) two ways on a
 * 2026-07-28 connection:
 *
 * 1. **auto-open via `ClientOptions.listChanged`** — the same option a
 *    2025-era client sets; on a modern connection the SDK auto-opens a
 *    listen stream with the filter derived from which sub-options were set,
 *    so the configured `onChanged` handlers fire on every published change;
 * 2. **manual `client.listen()`** — opens a stream explicitly, registers a
 *    `notifications/tools/list_changed` handler the stream feeds, and closes
 *    after a few notifications.
 *
 * The example calls `flip_tools` to mutate the server's tool set on demand
 * (rather than a timer), then asserts the change notification arrived.
 */
import { check, parseExampleArgs, siblingPath } from '@mcp-examples/shared';
import type { ClientOptions, McpSubscription } from '@modelcontextprotocol/client';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

/** Wait until `pred()` is true or `timeoutMs` elapses. */
async function until(pred: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for change notification');
        await new Promise(r => setTimeout(r, 25));
    }
}

const { transport, url } = parseExampleArgs();

// Both legs connect identically and differ only in ClientOptions; the local
// helper keeps the SDK transport setup visible in THIS file (the canonical
// shape) while avoiding duplicating it for each leg. Modern-only —
// `subscriptions/listen` is a 2026-07-28 protocol feature.
const connect = async (options?: ClientOptions): Promise<Client> => {
    const client = new Client(
        { name: 'subscriptions-example-client', version: '1.0.0' },
        { versionNegotiation: { mode: 'auto' }, ...options }
    );
    await (transport === 'stdio'
        ? client.connect(new StdioClientTransport({ command: 'npx', args: ['-y', 'tsx', siblingPath(import.meta.url, 'server.ts')] }))
        : client.connect(new StreamableHTTPClientTransport(new URL(url))));
    return client;
};

// --- auto-open via ClientOptions.listChanged ---
{
    let count = 0;
    const client = await connect({
        listChanged: {
            tools: {
                autoRefresh: false,
                // The default debounce coalesces bursts; this example asserts
                // raw delivery, so disable it.
                debounceMs: 0,
                onChanged: () => void count++
            }
        }
    });
    check.ok(client.autoOpenedSubscription, 'a listChanged option should auto-open a subscription on a modern connection');
    check.ok(client.autoOpenedSubscription?.honoredFilter.toolsListChanged, 'auto-opened filter should include toolsListChanged');

    await client.callTool({ name: 'flip_tools' });
    await until(() => count >= 1);
    await client.callTool({ name: 'flip_tools' });
    await until(() => count >= 2);

    await client.autoOpenedSubscription?.close();
    await client.close();
    check.ok(count >= 2, 'auto-open leg should receive at least two tools/list_changed');
}

// --- manual client.listen() ---
{
    const client = await connect();
    let count = 0;
    client.setNotificationHandler('notifications/tools/list_changed', () => void count++);
    const sub: McpSubscription = await client.listen({ toolsListChanged: true });
    check.ok(sub.honoredFilter.toolsListChanged, 'manual listen should honor toolsListChanged');

    await client.callTool({ name: 'flip_tools' });
    await until(() => count >= 1);
    await client.callTool({ name: 'flip_tools' });
    await until(() => count >= 2);

    await sub.close();
    await client.close();
    check.ok(count >= 2, 'manual leg should receive at least two tools/list_changed');
}
