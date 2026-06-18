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
import type { McpSubscription } from '@modelcontextprotocol/client';

import { check, connectFromArgs, runClient } from '../harness.js';

/** Wait until `pred()` is true or `timeoutMs` elapses. */
async function until(pred: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for change notification');
        await new Promise(r => setTimeout(r, 25));
    }
}

async function autoOpenLeg(): Promise<void> {
    let count = 0;
    // connectFromArgs picks transport (default: spawn ./server.ts over stdio; --http <url>) and era (--legacy) from argv. Your code would construct a Client and connect over your chosen transport directly.
    const client = await connectFromArgs(import.meta.dirname, {
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

async function manualLeg(): Promise<void> {
    const client = await connectFromArgs(import.meta.dirname);
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

runClient('subscriptions', async () => {
    await autoOpenLeg();
    await manualLeg();
});
