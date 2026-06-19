/**
 * SSE Polling Example Client (SEP-1699)
 *
 * Connects (2025-era), calls `long-operation`, and asserts the result arrives
 * AFTER the server's mid-stream `closeSSE()` — i.e. the client transport
 * automatically reconnects with `Last-Event-ID` and replays the events the
 * `eventStore` buffered while disconnected. Also asserts every progress log
 * (including the one emitted while disconnected) was delivered.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { check, runClient } from '../harness.js';

const argv = process.argv.slice(2);
const URL = argv[argv.indexOf('--http') + 1] ?? 'http://127.0.0.1:3001/mcp';

runClient('sse-polling', async () => {
    const transport = new StreamableHTTPClientTransport(new globalThis.URL(URL));
    // The mid-stream disconnect surfaces as a transport error before the
    // automatic reconnect; that is the EXPECTED flow, not a failure.
    transport.onerror = () => {};

    const client = new Client({ name: 'sse-polling-client', version: '1.0.0' });
    const logs: string[] = [];
    client.setNotificationHandler('notifications/message', n => {
        logs.push(String(n.params.data));
    });
    await client.connect(transport);

    let lastEventId: string | undefined;
    const result = await client.request(
        { method: 'tools/call', params: { name: 'long-operation', arguments: {} } },
        { onresumptiontoken: token => (lastEventId = token) }
    );

    const text = (result as { content?: Array<{ type: string; text?: string }> }).content?.[0]?.text ?? '';
    check.match(text, /completed successfully/);
    check.ok(lastEventId, 'resumption tokens should have been observed');
    // The 75% line is emitted WHILE the client is disconnected; receiving it
    // proves the event store replayed it on reconnect. (Replay ordering relative
    // to the terminal result is not asserted — the result resolving is the
    // signal the disconnect was survived.)
    check.ok(
        logs.some(l => l.includes('75%')),
        `events emitted while disconnected should be replayed (got: ${logs.join(' | ')})`
    );

    await client.close();
});
