---
shape: how-to
---
# Test a server

Drive your server through a real `Client`, in-process — no port, no socket, no mock transport.

## Serve the handler in-process

Start from the `createServer` factory you ship — here, one tool — and pass `handler.fetch` as the client transport's `fetch` option.

```ts source="../examples/guides/testing.examples.ts#inProcessHandler"
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
```

The transport never dials `http://test.local/mcp` — `handler.fetch` serves every request in-process, through the same `createMcpHandler` you deploy.

## Connect a client and call a tool

Create a `Client`, connect it over the transport, and call the tool. `versionNegotiation: { mode: 'auto' }` negotiates the newest protocol revision the handler serves.

```ts source="../examples/guides/testing.examples.ts#connectAndCall"
const client = new Client({ name: 'test-harness', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
await client.connect(transport);

const result = await client.callTool({ name: 'apply-discount', arguments: { price: 80, percent: 25 } });
console.log(result.structuredContent);
```

The handler answered in-process:

```
{ total: 60 }
```

## Assert on the result

Assert on `structuredContent` for the happy path; a handler failure resolves as an ordinary result with `isError: true`, not a thrown error.

```ts source="../examples/guides/testing.examples.ts#assertResult"
assert.deepStrictEqual(result.structuredContent, { total: 60 });

const failed = await client.callTool({ name: 'apply-discount', arguments: { price: -5, percent: 25 } });
assert.equal(failed.isError, true);
console.log(failed.content);
```

There is nothing to `catch` — `failed.content` carries the message the model would read:

```
[ { type: 'text', text: 'price must be >= 0' } ]
```

::: tip
This page uses `node:assert/strict`; swap in your runner's `expect` — nothing else changes. Arguments the input schema rejects produce the same `isError: true` result, so they assert the same way — see [Tools](./servers/tools.md).
:::

## Tear down between tests

Close both ends in your runner's `afterEach` — the client first, then the handler.

```ts source="../examples/guides/testing.examples.ts#tearDown"
await client.close();
await handler.close();
```

`handler.close()` aborts any exchange still in flight, so a hung tool call cannot leak into the next test.

## Pair two instances in memory

`InMemoryTransport.createLinkedPair()` returns two transports that are each other's wire — connect one instance to each end.

```ts source="../examples/guides/testing.examples.ts#linkedPair"
import { InMemoryTransport } from '@modelcontextprotocol/client';

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

const memServer = createServer();
const memClient = new Client({ name: 'test-harness', version: '1.0.0' });
await memServer.connect(serverTransport);
await memClient.connect(clientTransport);
```

`memClient.callTool` returns the same results over this pair. `createLinkedPair` connects 2025-era instances only; `handler.fetch` is the in-process entry for 2026-07-28 coverage — see [Protocol versions](./protocol-versions.md).

## Cover stdio by spawning the process

Stdio has no in-process shortcut: `StdioClientTransport`, imported from `@modelcontextprotocol/client/stdio`, spawns the command and connects to the child over its stdin and stdout.

```ts source="../examples/guides/testing.examples.ts#stdioSpawn"
const stdioClient = new Client({ name: 'test-harness', version: '1.0.0' });
await stdioClient.connect(new StdioClientTransport({ command: 'node', args: ['dist/server.js'] }));
```

From here the client behaves exactly as above, and `stdioClient.close()` shuts the child process down. [Serve over stdio](./serving/stdio.md) covers the server side.

## Recap

- `handler.fetch` passed as the transport's `fetch` option serves every request in-process; the transport never dials the URL.
- One `Client` plus one `createMcpHandler` is a complete no-socket integration test of the server you deploy.
- Assert on `structuredContent`; a handler failure resolves as a result with `isError: true`.
- Close the client, then the handler, between tests.
- `InMemoryTransport.createLinkedPair()` pairs 2025-era instances in memory.
- stdio coverage means spawning the real process with `StdioClientTransport`.
