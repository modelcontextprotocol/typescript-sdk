/**
 * Two clients in parallel, each calling the notification-emitting tool, and
 * one client making two parallel tool calls — asserts every result returns
 * and that notifications were attributed back to the right caller.
 *
 * Over HTTP every client connects to the one running endpoint; over stdio
 * each `makeClient` spawns its own server process (so the
 * "multiple clients" leg is per-process, while the "one client / parallel
 * calls" leg exercises one server's per-call attribution either way).
 */
import { check, parseExampleArgs, siblingPath } from '@mcp-examples/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

async function makeClient(): Promise<{ client: Client; notifications: string[] }> {
    const { transport, url, era } = parseExampleArgs();

    const client = new Client(
        { name: 'parallel-calls-example-client', version: '1.0.0' },
        { versionNegotiation: { mode: era === 'modern' ? 'auto' : 'legacy' } }
    );

    await (transport === 'stdio'
        ? client.connect(new StdioClientTransport({ command: 'npx', args: ['-y', 'tsx', siblingPath(import.meta.url, 'server.ts')] }))
        : client.connect(new StreamableHTTPClientTransport(new URL(url))));

    const notifications: string[] = [];
    client.setNotificationHandler('notifications/message', n => {
        notifications.push(String(n.params.data));
    });
    return { client, notifications };
}

// --- multiple clients, one call each ---
const [a, b] = await Promise.all([makeClient(), makeClient()]);
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
const c = await makeClient();
const results = await Promise.all([
    c.client.callTool({ name: 'start-notification-stream', arguments: { caller: 'C1', count: 2 } }),
    c.client.callTool({ name: 'start-notification-stream', arguments: { caller: 'C2', count: 2 } })
]);
check.equal(results.length, 2);
check.ok(c.notifications.some(m => m.includes('[C1]')) && c.notifications.some(m => m.includes('[C2]')));
await c.client.close();
