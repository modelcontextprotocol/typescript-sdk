/**
 * Connects, opens the standalone GET stream by registering a `listChanged`
 * handler, and asserts at least one `notifications/resources/list_changed`
 * arrives within the bound (the server adds a resource on a timer).
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { check, runClient } from '../harness.js';

const argv = process.argv.slice(2);
const URL = argv[argv.indexOf('--http') + 1] ?? 'http://127.0.0.1:3000/mcp';

runClient('standalone-get', async () => {
    let received = 0;
    let done!: () => void;
    const finished = new Promise<void>(resolve => {
        done = resolve;
    });
    const client = new Client(
        { name: 'standalone-get-client', version: '1.0.0' },
        { listChanged: { resources: { autoRefresh: false, onChanged: () => (++received >= 1 ? done() : undefined) } } }
    );
    await client.connect(new StreamableHTTPClientTransport(new globalThis.URL(URL)));
    const list = await client.listResources();
    check.ok(list.resources.length > 0);
    await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error('no listChanged within 8s')), 8000))]);
    check.ok(received >= 1);
    await client.close();
});
