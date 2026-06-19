/**
 * Connects (2025-era), opens the standalone GET stream by registering a
 * `listChanged` handler, calls `add_resource` to trigger a
 * `notifications/resources/list_changed` over that stream, and asserts it
 * arrived.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { check, runClient } from '../harness.js';

const argv = process.argv.slice(2);
const URL = argv[argv.indexOf('--http') + 1] ?? 'http://127.0.0.1:3000/mcp';

runClient('standalone-get', async () => {
    let received = 0;
    const client = new Client(
        { name: 'standalone-get-client', version: '1.0.0' },
        {
            // Explicitly the 2025 `initialize` handshake — the standalone GET
            // stream is a sessionful-2025 transport feature, so this story is
            // legacy-only by design (was reaching 2025 by fallback; pin it).
            versionNegotiation: { mode: 'legacy' },
            listChanged: { resources: { autoRefresh: false, debounceMs: 0, onChanged: () => void received++ } }
        }
    );
    await client.connect(new StreamableHTTPClientTransport(new globalThis.URL(URL)));

    const before = await client.listResources();
    check.ok(before.resources.length > 0);

    // Mutate on demand → server emits list_changed over the standalone GET stream.
    await client.callTool({ name: 'add_resource', arguments: { content: 'hello' } });
    const deadline = Date.now() + 5000;
    while (received < 1) {
        if (Date.now() > deadline) throw new Error('no listChanged within 5s');
        await new Promise(r => setTimeout(r, 25));
    }
    check.ok(received >= 1);

    const after = await client.listResources();
    check.ok(after.resources.length > before.resources.length);

    await client.close();
});
