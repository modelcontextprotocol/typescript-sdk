---
shape: how-to
---
# Serve over stdio

A host that launches your server as a local child process talks to it over **stdio**: JSON-RPC requests arrive on stdin, responses leave on stdout. To host one endpoint that many clients connect to, serve the same factory over [HTTP](./http.md) instead.

## Serve a factory over stdio

`serveStdio` takes a factory; it owns the transport and calls the factory to build the instance that serves the connection.

```ts source="../../examples/guides/serving/stdio.examples.ts#serveStdio_basic"
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const handle = serveStdio(() => {
    const server = new McpServer({ name: 'notes', version: '1.0.0' });
    // server.registerTool(...) — one factory builds the instance that serves the connection
    return server;
});
```

The process is now an MCP server. A host that spawns it lists and calls whatever the factory registered; until one does, the process waits on stdin.

::: info Coming from v1?
`serveStdio` replaces the `new StdioServerTransport()` + `server.connect(transport)` wiring — run the codemod, then see the [upgrade guide](../migration/upgrade-to-v2.md).
:::

::: info
`serveStdio` serves older clients from the same factory by default; the `legacy` option and the full story are on [Legacy clients](./legacy-clients.md). The entry also owns which protocol revision each connection negotiates — see [Protocol versions](../protocol-versions.md).
:::

## Log to stderr, never stdout

Announce readiness with `console.error`, which writes to stderr.

```ts source="../../examples/guides/serving/stdio.examples.ts#serveStdio_logStderr"
console.error('notes server is listening on stdio');
```

stdout is the JSON-RPC channel: the host parses every line of it as a protocol message. Add one `console.log('debug: starting the notes server')` to the program above and send it an `initialize` request. Its two output streams now carry:

```
[stdout] debug: starting the notes server
[stdout] {"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"notes","version":"1.0.0"}},"jsonrpc":"2.0","id":1}
[stderr] notes server is listening on stdio
```

The protocol channel opens with a line no JSON-RPC parser accepts, ahead of the `initialize` response. The `console.error` banner went to stderr, which the host keeps out of the channel and shows in its server log.

## Test it with the Inspector

The **MCP Inspector** launches your server command itself and connects to it over stdio.

```sh
npx @modelcontextprotocol/inspector node ./build/server.js
```

In the browser tab it opens, click **Connect**; the **Tools** tab lists and calls everything the factory registered, without configuring the server in a host.

## Shut down cleanly

`serveStdio` returns a **`StdioServerHandle`**; its `close()` tears down the pinned server instance and the transport.

```ts source="../../examples/guides/serving/stdio.examples.ts#serveStdio_shutdown"
process.on('SIGINT', () => {
    void handle.close();
});
```

`close()` resolves once the instance the factory built and the underlying transport are both shut down.

## Recap

- `serveStdio(factory)` is the stdio entry point: it owns the transport and calls your factory to build the instance that serves the connection.
- stdout is the protocol channel; log with `console.error`.
- One `console.log` puts a line no JSON-RPC parser accepts into the stream the host parses.
- `npx @modelcontextprotocol/inspector <command>` exercises a stdio server without configuring it in a host.
- The returned `StdioServerHandle`'s `close()` tears down the pinned instance and the transport.
