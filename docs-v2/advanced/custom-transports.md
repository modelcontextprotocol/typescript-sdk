---
status: scaffold
shape: how-to
---
# Custom transports

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Implement the Transport interface.
teaches: Transport, TransportSendOptions, JSONRPCMessage, start/send/close contract, onmessage/onerror/onclose, sessionId, setProtocolVersion, hasPerRequestStream, ReadBuffer, serializeMessage, deserializeMessage, InMemoryTransport.createLinkedPair
source: mined from docs/server.md "Transports"; docs/client.md "Connecting to a server"; net-new for the interface walkthrough
-->

## Implement the `Transport` interface
<!-- teaches: Transport — three methods (start, send, close) and three callbacks (onmessage, onerror, onclose) | salvage: net-new (interface in packages/core-internal/src/shared/transport.ts) -->
A **transport** moves `JSONRPCMessage` values in both directions. Implement three methods and expose three callbacks; the `Client` and `Server` classes drive everything else.

```ts
// draft - API verified against packages/core-internal/src/shared/transport.ts (Transport interface; re-exported by @modelcontextprotocol/server and /client via core-internal/src/exports/public/index.ts)
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/server';

export class WebSocketServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly socket: WebSocket) {}

  async start(): Promise<void> {
    this.socket.onmessage = event => {
      this.onmessage?.(JSON.parse(String(event.data)) as JSONRPCMessage);
    };
    this.socket.onerror = () => this.onerror?.(new Error('websocket error'));
    this.socket.onclose = () => this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.socket.send(JSON.stringify(message));
  }

  async close(): Promise<void> {
    this.socket.close();
    this.onclose?.();
  }
}
```
<!-- result: server.connect(new WebSocketServerTransport(socket)) speaks MCP over your channel -->

## Honor the callback contract
<!-- teaches: callbacks are installed BEFORE start(); never call start() yourself when handing the transport to Client/Server — connect() does; close() must fire onclose -->
<!-- code: none — three-rule contract list, mirrored from the interface JSDoc -->

## Connect it like a built-in transport
<!-- teaches: Client.connect(transport) / Server.connect(transport) take any Transport | salvage: docs/client.md "Connecting to a server" -->
<!-- code: await client.connect(new WebSocketClientTransport(socket)) -->

## Frame messages over a byte stream
<!-- teaches: ReadBuffer, serializeMessage, deserializeMessage — the newline-delimited framing the stdio transports use, exported for reuse -->
<!-- code: readBuffer.append(chunk); for (let msg; (msg = readBuffer.readMessage()); ) this.onmessage?.(msg) -->

## Report a session ID and the negotiated version
<!-- teaches: optional members the protocol layer calls back into — sessionId, setProtocolVersion(version), setSupportedProtocolVersions(versions) -->
<!-- code: sessionId getter + setProtocolVersion stub on the class -->

## Opt into per-request cancellation
<!-- teaches: hasPerRequestStream + TransportSendOptions.requestSignal — only for transports that open one underlying request per outbound JSON-RPC request; single-channel transports leave it undefined -->
<!-- code: readonly hasPerRequestStream = true; send(message, { requestSignal }) honors the abort -->

## Test it against the in-memory pair
<!-- teaches: InMemoryTransport.createLinkedPair as the reference Transport implementation and the harness to drive yours -->
<!-- code: const [clientSide, serverSide] = InMemoryTransport.createLinkedPair() -->

## Recap
<!-- the claims this page will prove:
* A transport is start/send/close plus onmessage/onerror/onclose — nothing else is required.
* connect() installs the callbacks and calls start() for you; never call start() first.
* ReadBuffer, serializeMessage and deserializeMessage give you stdio-style framing for free.
* sessionId, setProtocolVersion and hasPerRequestStream are optional hooks the protocol layer uses when present.
* InMemoryTransport is both the smallest reference implementation and the test harness for yours.
-->
