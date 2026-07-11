/**
 * Drives the streaming example: a `countdown` call with `onprogress`
 * (asserts progress notifications arrived), a logging-notification handler
 * (asserts log messages arrived), and a cancelled call (asserts the cancel
 * propagated).
 */
import { check, parseExampleArgs, siblingPath } from '@mcp-examples/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const { transport, url, era } = parseExampleArgs();

const client = new Client(
    { name: 'streaming-example-client', version: '1.0.0' },
    { versionNegotiation: { mode: era === 'modern' ? 'auto' : 'legacy' } }
);

await (transport === 'stdio'
    ? client.connect(new StdioClientTransport({ command: 'npx', args: ['-y', 'tsx', siblingPath(import.meta.url, 'server.ts')] }))
    : client.connect(new StreamableHTTPClientTransport(new URL(url))));

let logCount = 0;
client.setNotificationHandler('notifications/message', () => {
    logCount++;
});

// --- progress + logging ---
let progressCount = 0;
const result = await client.callTool(
    { name: 'countdown', arguments: { n: 5, delayMs: 20 } },
    {
        onprogress: p => {
            progressCount++;
            check.equal(p.total, 5);
        }
    }
);
check.equal((result.structuredContent as { completed?: number } | undefined)?.completed, 5);
check.equal((result.structuredContent as { cancelled?: boolean } | undefined)?.cancelled, false);
check.ok(progressCount >= 4, `expected >=4 progress notifications, got ${progressCount}`);
check.ok(logCount >= 4, `expected >=4 log notifications, got ${logCount}`);

// --- cancellation propagation ---
const ac = new AbortController();
setTimeout(() => ac.abort(), 60);
let cancelled = false;
try {
    await client.callTool({ name: 'countdown', arguments: { n: 50, delayMs: 50 } }, { signal: ac.signal });
} catch {
    cancelled = true;
}
check.ok(cancelled, 'a client-side abort should reject the in-flight callTool');

await client.close();
