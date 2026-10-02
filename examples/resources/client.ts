/**
 * Drives the resources example: list, list templates, read direct + templated,
 * then subscribe to `counter://value` and assert the update notification. The
 * subscription sender is era-split — `subscriptions/listen` on 2026-07-28,
 * `resources/subscribe` on 2025 — while the notification handler is one
 * registration either way. Per-request legacy HTTP has no channel to deliver
 * notifications, so that leg asserts the calls succeed and skips the delivery
 * assertion.
 */
import { check, parseExampleArgs, siblingPath } from '@mcp-examples/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const { transport, url, era } = parseExampleArgs();

const client = new Client(
    { name: 'resources-example-client', version: '1.0.0' },
    { versionNegotiation: { mode: era === 'modern' ? 'auto' : 'legacy' } }
);

await (transport === 'stdio'
    ? client.connect(new StdioClientTransport({ command: 'npx', args: ['-y', 'tsx', siblingPath(import.meta.url, 'server.ts')] }))
    : client.connect(new StreamableHTTPClientTransport(new URL(url))));

const list = await client.listResources();
check.ok(list.resources.some(r => r.uri === 'config://app'));
check.ok(list.resources.some(r => r.uri === 'counter://value'));

const templates = await client.listResourceTemplates();
check.ok(templates.resourceTemplates.some(t => t.uriTemplate === 'greeting://{name}'));

const config = await client.readResource({ uri: 'config://app' });
const configContent = config.contents[0];
check.equal(configContent && 'text' in configContent ? configContent.text : '', '{"feature":true}');

const hello = await client.readResource({ uri: 'greeting://world' });
const helloContent = hello.contents[0];
check.equal(helloContent && 'text' in helloContent ? helloContent.text : '', 'Hello, world!');

// --- Subscriptions ---------------------------------------------------------

// One handler serves both delivery paths: the 2026-07-28 listen stream and a
// 2025-era connection's unsolicited notification dispatch the same way.
let resolveUpdated: ((uri: string) => void) | undefined;
client.setNotificationHandler('notifications/resources/updated', notification => {
    resolveUpdated?.(notification.params.uri);
});

// Per-request legacy HTTP answers each POST in isolation: subscribing succeeds,
// but there is no stream to deliver the notification on.
const deliverable = !(era === 'legacy' && transport === 'http');

const updated = new Promise<string>(resolve => {
    resolveUpdated = resolve;
});

const subscription = era === 'modern' ? await client.listen({ resourceSubscriptions: ['counter://value'] }) : undefined;
if (era === 'legacy') {
    await client.subscribeResource({ uri: 'counter://value' });
}

const bumped = await client.callTool({ name: 'increment', arguments: {} });
check.ok(!bumped.isError);
const bumpedContent = bumped.content[0];
const bumpedValue = bumpedContent && bumpedContent.type === 'text' ? bumpedContent.text : '';

if (deliverable) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('no resources/updated within 8s')), 8000);
    });
    const updatedUri = await Promise.race([updated, timeout]).finally(() => clearTimeout(timer));
    check.equal(updatedUri, 'counter://value');

    // The resource and the tool observe the same state: the re-read matches the
    // value increment returned (not a literal, so a long-lived server re-runs).
    const counter = await client.readResource({ uri: 'counter://value' });
    const counterContent = counter.contents[0];
    check.equal(counterContent && 'text' in counterContent ? counterContent.text : '', bumpedValue);
}

if (subscription) {
    await subscription.close();
} else if (era === 'legacy') {
    await client.unsubscribeResource({ uri: 'counter://value' });
}

await client.close();
