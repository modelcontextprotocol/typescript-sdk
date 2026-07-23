---
shape: how-to
---
# Logging, progress, and cancellation

Every handler receives a **context** as its second argument; the request-scoped helpers — progress, logging, and the cancellation signal — live on `ctx.mcpReq`.

## Report progress from a handler

A client that wants progress puts a `progressToken` in the request's `_meta`. Read it from `ctx.mcpReq._meta` and send each update with `ctx.mcpReq.notify`.

```ts source="../../examples/guides/servers/logging-progress-cancellation.examples.ts#registerTool_progress"
server.registerTool(
    'process-files',
    {
        description: 'Process files with progress updates',
        inputSchema: z.object({ files: z.array(z.string()) })
    },
    async ({ files }, ctx) => {
        const progressToken = ctx.mcpReq._meta?.progressToken;

        for (let i = 0; i < files.length; i++) {
            // ... process files[i] ...

            if (progressToken !== undefined) {
                await ctx.mcpReq.notify({
                    method: 'notifications/progress',
                    params: { progressToken, progress: i + 1, total: files.length, message: `Processed ${files[i]}` }
                });
            }
        }

        return { content: [{ type: 'text', text: `Processed ${files.length} files` }] };
    }
);
```

Every call on this page comes from an in-memory `Client` connected to this server — [Test a server](../testing.md) shows that wiring. Pass an `onprogress` callback and the SDK puts the `progressToken` in `_meta` for you.

```ts source="../../examples/guides/servers/logging-progress-cancellation.examples.ts#callTool_onprogress"
const result = await client.callTool(
    { name: 'process-files', arguments: { files: ['a.csv', 'b.csv', 'c.csv'] } },
    { onprogress: update => console.log(update) }
);
console.log(result.content);
```

The callback fires once per file, then the call resolves:

```
{ progress: 1, total: 3, message: 'Processed a.csv' }
{ progress: 2, total: 3, message: 'Processed b.csv' }
{ progress: 3, total: 3, message: 'Processed c.csv' }
[ { type: 'text', text: 'Processed 3 files' } ]
```

## Skip progress when the client did not ask

Drop `onprogress` and the same request arrives with no `progressToken`, so the guard in the handler sends nothing.

```ts source="../../examples/guides/servers/logging-progress-cancellation.examples.ts#callTool_noProgress"
const quiet = await client.callTool({ name: 'process-files', arguments: { files: ['d.csv', 'e.csv'] } });
console.log(quiet.content);
```

Only the result comes back:

```
[ { type: 'text', text: 'Processed 2 files' } ]
```

`progress` must increase on every notification for the same token; `total` and `message` are optional.

## Log to the client

::: warning Deprecated — SEP-2577
Log to `stderr` (stdio servers) or use OpenTelemetry instead. **MCP logging** is deprecated as of protocol version 2026-07-28 (SEP-2577) and stays functional through the deprecation window (at least twelve months) — see the [deprecated features registry](https://modelcontextprotocol.io/specification/draft/deprecated).
:::

Declare the `logging` capability when you construct the server.

```ts source="../../examples/guides/servers/logging-progress-cancellation.examples.ts#logging_capability"
const server = new McpServer({ name: 'file-processor', version: '1.0.0' }, { capabilities: { logging: {} } });
```

`ctx.mcpReq.log(level, data)` then sends a `notifications/message` from inside any handler — `data` is any JSON value.

```ts source="../../examples/guides/servers/logging-progress-cancellation.examples.ts#registerTool_logging"
server.registerTool(
    'validate-records',
    {
        description: 'Validate records before import',
        inputSchema: z.object({ records: z.array(z.string()) })
    },
    async ({ records }, ctx) => {
        await ctx.mcpReq.log('info', `Validating ${records.length} records`);
        const invalid = records.filter(record => !record.endsWith('.csv'));
        if (invalid.length > 0) {
            await ctx.mcpReq.log('warning', { invalid });
        }
        return { content: [{ type: 'text', text: `${records.length - invalid.length} of ${records.length} records are valid` }] };
    }
);
```

The connected client surfaces each one through its `notifications/message` handler.

```ts source="../../examples/guides/servers/logging-progress-cancellation.examples.ts#setNotificationHandler_message"
client.setNotificationHandler('notifications/message', notification => {
    console.log(notification.params.level, notification.params.data);
});
```

Calling `validate-records` with one bad record delivers both log notifications before the result:

```
info Validating 2 records
warning { invalid: [ 'b.txt' ] }
[ { type: 'text', text: '1 of 2 records are valid' } ]
```

How the client's log level reaches `ctx.mcpReq.log` differs by protocol era — see [Protocol versions](../protocol-versions.md).

## Stop work when the request is cancelled

`ctx.mcpReq.signal` is an `AbortSignal`. The SDK aborts it when the client sends `notifications/cancelled` for the request, and when the connection closes — check it before each unit of work.

```ts source="../../examples/guides/servers/logging-progress-cancellation.examples.ts#registerTool_abort"
server.registerTool(
    'scan-archive',
    {
        description: 'Scan every page of the archive',
        inputSchema: z.object({ pages: z.number().int() })
    },
    async ({ pages }, ctx) => {
        let scanned = 0;
        for (let page = 0; page < pages; page++) {
            if (ctx.mcpReq.signal.aborted) {
                console.error(`Stopped after ${scanned} of ${pages} pages: ${ctx.mcpReq.signal.reason}`);
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 100)); // ... scan one page ...
            scanned++;
        }
        return { content: [{ type: 'text', text: `Scanned ${scanned} pages` }] };
    }
);
```

Cancel from the client by aborting the signal you pass to the call.

```ts source="../../examples/guides/servers/logging-progress-cancellation.examples.ts#callTool_abort"
const controller = new AbortController();
const scan = client.callTool({ name: 'scan-archive', arguments: { pages: 40 } }, { signal: controller.signal });

// the end user clicks Stop while the scan runs
setTimeout(() => controller.abort('the end user clicked Stop'), 5);

await scan.catch(error => console.log(String(error)));
```

The call rejects on the client and the handler stops at its next check; the abort reason travels in the notification and comes out as `ctx.mcpReq.signal.reason`:

```
SdkError: the end user clicked Stop
Stopped after 1 of 40 pages: the end user clicked Stop
```

The first line is the client's rejection, the second is the handler's `console.error` on the server. The SDK never sends a response for a cancelled request and discards whatever the handler still returns.

## Pass the signal to your own I/O

Hand the same signal to `fetch` — or any API that accepts an `AbortSignal` — and cancellation propagates into the work the handler started.

```ts source="../../examples/guides/servers/logging-progress-cancellation.examples.ts#registerTool_forwardSignal"
const SOURCE_URLS = {
    readme: 'https://example.com/sources/readme.md',
    changelog: 'https://example.com/sources/changelog.md'
};

server.registerTool(
    'fetch-source',
    {
        description: 'Download one of the known source files',
        inputSchema: z.object({ source: z.enum(['readme', 'changelog']) })
    },
    async ({ source }, ctx) => {
        const response = await fetch(SOURCE_URLS[source], { signal: ctx.mcpReq.signal });
        return { content: [{ type: 'text', text: await response.text() }] };
    }
);
```

On cancellation `fetch` rejects mid-download and the handler unwinds with it, so no work outlives the request.

::: warning
Resolve an identifier against a fixed list, as `fetch-source` does. A tool that fetches a caller-supplied URL lets any connected client drive requests from your server's network position (server-side request forgery).
:::

## Recap

- Every handler receives a context as its second argument; the request-scoped helpers live on `ctx.mcpReq`.
- `ctx.mcpReq.notify` sends `notifications/progress` when the request carried a `progressToken`; `progress` must increase on each one.
- `ctx.mcpReq.log(level, data)` sends `notifications/message` once the `logging` capability is declared; MCP logging is deprecated (SEP-2577).
- `ctx.mcpReq.signal` aborts on cancellation and disconnect — check it in long loops and forward it to your own I/O.
