/**
 * Gateway / distributed-client pattern: probe once, persist the
 * `DiscoverResult`, feed it to every worker for a zero-round-trip connect.
 *
 * 1. A "bootstrap" client connects with `versionNegotiation: { mode: 'auto' }`
 *    — one `server/discover` round trip — and reads `getDiscoverResult()`.
 * 2. The result is `JSON.stringify`-ed (the "persist" step — in a real gateway
 *    you would write this to Redis, a config map, or a process-local cache).
 * 3. Three fresh worker clients connect with
 *    `connect(transport, { prior: JSON.parse(persisted) })`: each connect()
 *    sends nothing on the wire, and `callTool` works immediately.
 * 4. The server's `request_count` tool proves it: after three worker connects
 *    the count is unchanged (no extra discover/initialize from the workers).
 *
 * **Security:** the persisted advertisement is what the server returned for the
 * bootstrap client's credential. Only reuse it across workers that present the
 * SAME authorization context — here every client speaks to the same
 * unauthenticated endpoint, so the constraint holds trivially. Do not share a
 * `DiscoverResult` across principals.
 */
import { check, parseExampleArgs } from '@mcp-examples/shared';
import type { DiscoverResult } from '@modelcontextprotocol/client';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

async function requestCount(client: Client): Promise<number> {
    const r = await client.callTool({ name: 'request_count' });
    return Number((r.content?.[0] as { text: string }).text);
}

const { url } = parseExampleArgs();

// ---------------------------------------------------------------------
// Step 1: bootstrap — one server/discover probe.
// ---------------------------------------------------------------------
const bootstrap = new Client({ name: 'gateway-bootstrap', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
await bootstrap.connect(new StreamableHTTPClientTransport(new URL(url)));
check.equal(bootstrap.getNegotiatedProtocolVersion(), '2026-07-28');

const discovered = bootstrap.getDiscoverResult();
check.ok(discovered, 'bootstrap connect populated getDiscoverResult()');
check.deepEqual(discovered?.serverInfo, { name: 'gateway-target', version: '1.0.0' });

// The probe was the only request so far; the request_count call is the
// second. (createMcpHandler builds one server instance per request.)
check.equal(await requestCount(bootstrap), 2);

// ---------------------------------------------------------------------
// Step 2: persist. In a real gateway you'd write this to Redis / a config
// map / a process-local cache here. JSON round-trips by design.
// ---------------------------------------------------------------------
const persisted: string = JSON.stringify(discovered);
await bootstrap.close();

// ---------------------------------------------------------------------
// Step 3: three fresh workers connect from the persisted blob — zero
// round trips each. Every worker presents the same authorization context
// as the bootstrap (unauthenticated here), so reuse is safe.
// ---------------------------------------------------------------------
const prior: DiscoverResult = JSON.parse(persisted) as DiscoverResult;
const workers = await Promise.all(
    ['worker-a', 'worker-b', 'worker-c'].map(async name => {
        const worker = new Client({ name, version: '1.0.0' });
        await worker.connect(new StreamableHTTPClientTransport(new URL(url)), { prior });
        // Adopted directly from prior — no probe, no initialize.
        check.equal(worker.getNegotiatedProtocolVersion(), '2026-07-28');
        check.deepEqual(worker.getServerVersion(), { name: 'gateway-target', version: '1.0.0' });
        return worker;
    })
);

// ---------------------------------------------------------------------
// Step 4: prove it. Three connect() calls and the count is unchanged
// (still 2 from the bootstrap leg + this request_count call = 3). Had
// each worker probed/initialized, this would read 6.
// ---------------------------------------------------------------------
check.equal(await requestCount(workers[0]!), 3);

// Each worker can callTool immediately.
for (const [i, worker] of workers.entries()) {
    const echoed = await worker.callTool({ name: 'echo', arguments: { text: `hello from ${i}` } });
    check.equal((echoed.content?.[0] as { text: string }).text, `hello from ${i}`);
}

// 3 (above) + 3 echo calls + this request_count call = 7.
check.equal(await requestCount(workers[0]!), 7);

for (const worker of workers) await worker.close();
