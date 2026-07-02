/**
 * Companion example for `docs/testing.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: it is the no-socket
 * client harness the page teaches — `createMcpHandler` served through
 * `handler.fetch`, then `InMemoryTransport.createLinkedPair()` — and every
 * output the page quotes verbatim is printed by this program.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/testing.examples.ts        # from examples/
 *
 * @module
 */
/* eslint-disable no-console */

// ## Serve the handler in-process

//#region inProcessHandler
import assert from 'node:assert/strict';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

function createServer() {
    const server = new McpServer({ name: 'pricing', version: '1.0.0' });
    server.registerTool(
        'apply-discount',
        {
            description: 'Apply a percentage discount to a price',
            inputSchema: z.object({ price: z.number(), percent: z.number().min(0).max(100) }),
            outputSchema: z.object({ total: z.number() })
        },
        async ({ price, percent }) => {
            if (price < 0) {
                return { content: [{ type: 'text', text: 'price must be >= 0' }], isError: true };
            }
            const total = price * (1 - percent / 100);
            return { content: [{ type: 'text', text: `$${total}` }], structuredContent: { total } };
        }
    );
    return server;
}

const handler = createMcpHandler(createServer);

const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init))
});
//#endregion inProcessHandler

// ## Connect a client and call a tool

//#region connectAndCall
const client = new Client({ name: 'test-harness', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
await client.connect(transport);

const result = await client.callTool({ name: 'apply-discount', arguments: { price: 80, percent: 25 } });
console.log(result.structuredContent);
//#endregion connectAndCall

// Proof for the page's claim that this wiring exercises the real 2026-07-28
// HTTP path. Throws (non-zero exit) if the claim is false.
assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');

// ## Assert on the result

//#region assertResult
assert.deepStrictEqual(result.structuredContent, { total: 60 });

const failed = await client.callTool({ name: 'apply-discount', arguments: { price: -5, percent: 25 } });
assert.equal(failed.isError, true);
console.log(failed.content);
//#endregion assertResult

// ## Tear down between tests

//#region tearDown
await client.close();
await handler.close();
//#endregion tearDown

// ## Pair two instances in memory

//#region linkedPair
import { InMemoryTransport } from '@modelcontextprotocol/client';

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

const memServer = createServer();
const memClient = new Client({ name: 'test-harness', version: '1.0.0' });
await memServer.connect(serverTransport);
await memClient.connect(clientTransport);
//#endregion linkedPair

// ---------------------------------------------------------------------------
// Harness (not shown on the page). Proves the page's prose claims, then
// closes the linked pair so the program terminates on its own.
// ---------------------------------------------------------------------------

// "The same `callTool` from above returns the same result over this pair."
const paired = await memClient.callTool({ name: 'apply-discount', arguments: { price: 80, percent: 25 } });
assert.deepStrictEqual(paired.structuredContent, { total: 60 });

// Proof for the page's era caveat: the linked pair runs the 2025 handshake,
// not the 2026-07-28 revision the `handler.fetch` harness above negotiated.
assert.equal(memClient.getNegotiatedProtocolVersion(), '2025-11-25');

await memClient.close();
await memServer.close();

// ## Cover stdio by spawning the process
//
// `StdioClientTransport.start()` spawns a real child process, so this region
// lives in a wrapper that typechecks but is never called.

import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

async function coverStdio() {
    //#region stdioSpawn
    const stdioClient = new Client({ name: 'test-harness', version: '1.0.0' });
    await stdioClient.connect(new StdioClientTransport({ command: 'node', args: ['dist/server.js'] }));
    //#endregion stdioSpawn
    return stdioClient;
}

void coverStdio;

console.log('testing.examples.ts: all assertions passed');
