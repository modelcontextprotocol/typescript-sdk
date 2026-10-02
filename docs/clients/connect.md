---
shape: how-to
---
# Connect to a server

A **client** holds one connection to one server: construct a `Client`, pick a **transport**, and `connect()`.

## Create a client and connect over HTTP

`Client` takes a name and a version; `StreamableHTTPClientTransport` takes the server's MCP endpoint URL.

```ts source="../../examples/guides/clients/connect.examples.ts#connect_streamableHttp"
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'my-client', version: '1.0.0' });

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'));

await client.connect(transport);
```

`connect()` runs the `initialize` handshake and resolves once it completes. The client now holds the negotiated protocol version, the server's capabilities, and its instructions.

::: info Coming from v1?
`Client` and the transport classes keep their names — only the import paths moved, to `@modelcontextprotocol/client` and its `/stdio` subpath. Run the codemod, then see the [upgrade guide](../migration/upgrade-to-v2.md).
:::

## Connect to a local process over stdio

For a server you run as a child process, change only the transport: `StdioClientTransport`, imported from `@modelcontextprotocol/client/stdio`, spawns the command and speaks JSON-RPC over its stdin and stdout.

```ts source="../../examples/guides/clients/connect.examples.ts#connect_stdio"
const client = new Client({ name: 'my-client', version: '1.0.0' });

const transport = new StdioClientTransport({ command: 'node', args: ['server.js'] });

await client.connect(transport);
```

`server.js` runs as a child of your process. `close()` shuts it down in order: close stdin, then `SIGTERM`, then `SIGKILL`.

::: tip
`InMemoryTransport.createLinkedPair()` is the third transport: it links a `Client` and an `McpServer` inside one process, no network and no child process. [Test a server](../testing.md) builds on it.
:::

## Fall back to SSE for servers that predate Streamable HTTP

An SSE-only server speaks the older HTTP+SSE transport instead of Streamable HTTP. Try `StreamableHTTPClientTransport` first; when it fails, retry with `SSEClientTransport` on a fresh `Client`.

```ts source="../../examples/guides/clients/connect.examples.ts#connect_sseFallback"
try {
    const client = new Client({ name: 'my-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return client;
} catch {
    const client = new Client({ name: 'my-client', version: '1.0.0' });
    await client.connect(new SSEClientTransport(new URL(url)));
    return client;
}
```

Whichever branch returns, the `Client` behaves the same from here on — nothing downstream depends on the transport.

::: info
`versionNegotiation` in `ClientOptions` controls which protocol revision `connect()` negotiates — see [Protocol versions](../protocol-versions.md).
:::

## Read what the server told you at connect time

Three accessors return what the server declared during the handshake; all of them return `undefined` until `connect()` resolves.

```ts source="../../examples/guides/clients/connect.examples.ts#connect_introspect"
console.log(client.getServerVersion());
console.log(client.getServerCapabilities());
console.log(client.getInstructions());
```

Connected to a server named `travel` that registered one tool and set `instructions`, that prints:

```
{ name: 'travel', version: '2.1.0' }
{ tools: { listChanged: true } }
Call list-trips before book-trip. Dates are ISO 8601.
```

The capability object gates every verb on [the next page](./calling.md): only ask for what the server advertised. `getInstructions()` is the server's usage guide for the model — put it in the system prompt.

A fourth accessor, `getDiscoverResult()`, tells the eras apart at connect time. Present, it is the modern-era `DiscoverResult` — persistable with `JSON.stringify` and usable on a later connect as `prior: { kind: 'modern', discover }` to skip the probe. Absent on a connected client, the era is legacy. This page's client used the default legacy handshake:

```ts source="../../examples/guides/clients/connect.examples.ts#connect_discoverResult"
// The default mode ran the legacy initialize handshake — no DiscoverResult.
console.log(client.getDiscoverResult());
```

```
undefined
```

Under `versionNegotiation: { mode: 'auto' }` against a 2026-era server it returns the advertisement — see [Protocol versions](../protocol-versions.md#skip-the-probe-with-a-cached-verdict) for the cached-verdict shapes and [Caching discovery verdicts](../advanced/gateway.md#caching-discovery-verdicts) for the full host-side loop.

## Disconnect cleanly

Over Streamable HTTP, terminate the server-side session, then close the client.

```ts source="../../examples/guides/clients/connect.examples.ts#connect_close"
await transport.terminateSession();
await client.close();
```

`close()` tears down the transport and rejects every request still in flight with a `CONNECTION_CLOSED` error. `terminateSession()` returns without sending anything when the server never issued a session ID. On the other transports, `close()` alone is the whole teardown.

## Recap

- `new Client({ name, version })`, a transport, and `connect()` are the whole setup; `connect()` runs the `initialize` handshake.
- `StreamableHTTPClientTransport` connects to remote servers; `StdioClientTransport`, from `@modelcontextprotocol/client/stdio`, spawns local ones; `SSEClientTransport` is the fallback for SSE-only servers.
- `InMemoryTransport.createLinkedPair()` links a client and a server in one process.
- After `connect()`, `getServerVersion()`, `getServerCapabilities()`, and `getInstructions()` return what the server declared; `getDiscoverResult()` tells the eras apart (present = modern, absent = legacy).
- `close()` tears down the transport and rejects in-flight requests.
- Protocol-revision differences live on the protocol versions page, not here.
