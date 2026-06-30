---
status: scaffold
shape: how-to
---
# Connect to a server

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Client + transports, what you can ask after connect.
teaches: Client, Client.connect, StreamableHTTPClientTransport, StdioClientTransport, SSEClientTransport, Client.close, Client.getInstructions, ConnectOptions
source: mined from docs/client.md "Connecting to a server", "Disconnecting", "Server instructions", "Protocol version negotiation"
-->

## Create a client and connect over HTTP

<!-- teaches: Client, StreamableHTTPClientTransport, Client.connect | salvage: docs/client.md "Streamable HTTP" -->

```ts
// draft - API verified against packages/client/src/client/client.ts and packages/client/src/client/streamableHttp.ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'my-client', version: '1.0.0' });

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'));

await client.connect(transport);
```

<!-- result: connect() resolves once the initialize handshake completes; the client now holds the negotiated protocol version and the server's capabilities. -->
<!-- aside (::: info Coming from v1?): Client and the transport classes keep their names; the import
     paths moved to @modelcontextprotocol/client (and its /stdio subpath) — run the codemod, then see
     /migration/upgrade-to-v2. (proposal §3 path 3: the standard aside, mandatory on this page) -->

## Connect to a local process over stdio

<!-- teaches: StdioClientTransport (@modelcontextprotocol/client/stdio) | salvage: docs/client.md "stdio" -->
<!-- code: same Client, StdioClientTransport({ command, args }) spawning the server process; note the /stdio subpath import -->

## Fall back to SSE for legacy servers

<!-- teaches: SSEClientTransport | salvage: docs/client.md "SSE fallback for legacy servers" -->
<!-- code: try StreamableHTTPClientTransport, catch, retry with SSEClientTransport on a fresh Client -->
<!-- aside: ::: info — one-line era cross-link to /protocol-versions; version negotiation (ConnectOptions / setVersionNegotiation) is a labeled aside, not main flow -->

## Read what the server told you at connect time

<!-- teaches: Client.getServerVersion, Client.getServerCapabilities, Client.getInstructions | salvage: docs/client.md "Server instructions", "Extension capabilities" -->
<!-- code: log getServerVersion(), getServerCapabilities(), getInstructions() after connect -->
<!-- result: the capability object is what gates every verb on the next page -->

## Disconnect cleanly

<!-- teaches: Client.close | salvage: docs/client.md "Disconnecting" -->
<!-- code: await client.close() -->

## Recap

<!-- the claims this page will prove:
- new Client({ name, version }) plus a transport plus connect() is the whole setup.
- StreamableHTTPClientTransport is the default for remote servers; StdioClientTransport (from /stdio) for local processes; SSEClientTransport only as a legacy fallback.
- connect() performs initialization; afterwards getServerCapabilities()/getInstructions() are populated.
- close() tears down the transport.
- Era differences live on /protocol-versions, not here.
-->
