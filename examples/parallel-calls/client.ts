/**
 * Two clients in parallel, each calling the notification-emitting tool, and
 * one client making two parallel tool calls — asserts every result returns
 * and that notifications were attributed back to the right caller.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { check, runClient } from '../harness.js';

const argv = process.argv.slice(2);
const URL = argv[argv.indexOf('--http') + 1] ?? 'http://127.0.0.1:3000/';

async function makeClient(id: string): Promise<{ client: Client; notifications: string[] }> {
    const client = new Client({ name: `parallel-${id}`, version: '1.0.0' });
    const notifications: string[] = [];
    client.setNotificationHandler('notifications/message', n => {
        notifications.push(String(n.params.data));
    });
    await client.connect(new StreamableHTTPClientTransport(new globalThis.URL(URL)));
    return { client, notifications };
}

runClient('parallel-calls', async () => {
    // --- multiple clients, one call each ---
    const [a, b] = await Promise.all([makeClient('A'), makeClient('B')]);
    const [ra, rb] = await Promise.all([
        a.client.callTool({ name: 'start-notification-stream', arguments: { caller: 'A', count: 3 } }),
        b.client.callTool({ name: 'start-notification-stream', arguments: { caller: 'B', count: 3 } })
    ]);
    check.match(ra.content?.[0]?.type === 'text' ? ra.content[0].text : '', /\[A\] done/);
    check.match(rb.content?.[0]?.type === 'text' ? rb.content[0].text : '', /\[B\] done/);
    check.ok(a.notifications.every(m => m.includes('[A]')));
    check.ok(b.notifications.every(m => m.includes('[B]')));
    check.ok(a.notifications.length >= 3 && b.notifications.length >= 3);
    await a.client.close();
    await b.client.close();

    // --- one client, parallel tool calls ---
    const c = await makeClient('C');
    const results = await Promise.all([
        c.client.callTool({ name: 'start-notification-stream', arguments: { caller: 'C1', count: 2 } }),
        c.client.callTool({ name: 'start-notification-stream', arguments: { caller: 'C2', count: 2 } })
    ]);
    check.equal(results.length, 2);
    check.ok(c.notifications.some(m => m.includes('[C1]')) && c.notifications.some(m => m.includes('[C2]')));
    await c.client.close();
});
