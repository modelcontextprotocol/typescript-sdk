---
shape: how-to
---
# Custom transports

A **transport** moves `JSONRPCMessage` values in both directions over a channel the SDK knows nothing about. Implement the `Transport` interface and `connect()` accepts it like a built-in one.

## Implement the `Transport` interface

Three methods — `start`, `send`, `close` — and three callbacks the SDK installs: `onmessage`, `onerror`, `onclose`. This loopback delivers each message straight to a linked peer in the same process.

```ts source="../../examples/guides/advanced/custom-transports.examples.ts#transport_loopback"
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/server';

export class LoopbackTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    private peer?: LoopbackTransport;

    /** Cross-wire two ends: whatever one end sends, the other receives. */
    static link(a: LoopbackTransport, b: LoopbackTransport): void {
        a.peer = b;
        b.peer = a;
    }

    async start(): Promise<void> {
        // Open your channel here. The loopback has nothing to open.
    }

    async send(message: JSONRPCMessage): Promise<void> {
        const peer = this.peer;
        if (!peer) throw new Error('Loopback peer is gone');
        queueMicrotask(() => peer.onmessage?.(message));
    }

    async close(): Promise<void> {
        this.peer = undefined;
        this.onclose?.();
    }
}
```

The SDK never looks inside your channel: it calls `send` for every outbound message and expects every inbound one on `onmessage`. Both `@modelcontextprotocol/server` and `@modelcontextprotocol/client` export `Transport`, `TransportSendOptions`, and `JSONRPCMessage`, so one implementation serves either side.

## Honor the callback contract

The interface carries three rules that no type checker enforces.

- Never call `start()` on a transport you hand to a `Client` or `Server`: `connect()` installs the three callbacks and then calls `start()` itself. A transport that starts reading before the callbacks exist drops messages.
- `close()` must end by firing your own `onclose` — the protocol layer tears down its side of the connection from that callback, however the channel ended.
- `onerror` reports out-of-band conditions (a malformed frame, a dropped socket) and is not necessarily fatal. For a failure the sender must see, throw from `send` instead.

## Connect it like a built-in transport

`Client.connect()` and `McpServer.connect()` take any `Transport`. Link two loopback ends, hand one to each side, and call a tool.

```ts source="../../examples/guides/advanced/custom-transports.examples.ts#connect_loopback"
import { Client } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';

const server = new McpServer({ name: 'loopback-demo', version: '1.0.0' });
server.registerTool('ping', { description: 'Reply with pong' }, async () => ({
    content: [{ type: 'text', text: 'pong' }]
}));

const client = new Client({ name: 'loopback-client', version: '1.0.0' });

const serverEnd = new LoopbackTransport();
const clientEnd = new LoopbackTransport();
LoopbackTransport.link(serverEnd, clientEnd);

await server.connect(serverEnd);
await client.connect(clientEnd);

const result = await client.callTool({ name: 'ping' });
console.log(result.content);
```

The whole MCP handshake and the tool call run over the loopback; the handler's `content` comes back unchanged:

```
[ { type: 'text', text: 'pong' } ]
```

## Frame messages over a byte stream

The loopback hands its peer a parsed object. A socket hands you bytes — frame them with the same helpers the stdio transports use: `ReadBuffer` buffers chunks and yields one parsed message per newline-delimited line, `serializeMessage` writes one, and `deserializeMessage` parses a single line you already hold.

```ts source="../../examples/guides/advanced/custom-transports.examples.ts#transport_socket"
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/server';
import type { Socket } from 'node:net';

export class SocketTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    private readonly readBuffer = new ReadBuffer();

    constructor(private readonly socket: Socket) {}

    async start(): Promise<void> {
        this.socket.on('data', chunk => {
            try {
                this.readBuffer.append(chunk);
                let message = this.readBuffer.readMessage();
                while (message !== null) {
                    this.onmessage?.(message);
                    message = this.readBuffer.readMessage();
                }
            } catch (error) {
                this.onerror?.(error as Error);
            }
        });
        this.socket.on('error', error => this.onerror?.(error));
        this.socket.on('close', () => this.onclose?.());
    }

    async send(message: JSONRPCMessage): Promise<void> {
        this.socket.write(serializeMessage(message));
    }

    async close(): Promise<void> {
        this.socket.end();
    }
}
```

`readMessage()` returns `null` until a complete line has arrived and skips non-JSON lines, so partial chunks, coalesced writes, and stray debug output all come out as whole `JSONRPCMessage` values or not at all.

::: tip
`ReadBuffer` throws once its buffer exceeds 10 MB (`STDIO_DEFAULT_MAX_BUFFER_SIZE`). Pass `new ReadBuffer({ maxBufferSize })` to raise the cap.
:::

## Report a session ID and the negotiated version

Three optional members let the protocol layer talk back to your transport; the SDK uses each one only when it is present. Set `sessionId` when your channel has one, and declare `setProtocolVersion` to receive the protocol version the two sides negotiated during `initialize`.

```ts source="../../examples/guides/advanced/custom-transports.examples.ts#transport_session"
export class SessionLoopbackTransport extends LoopbackTransport {
    sessionId?: string;

    protocolVersion?: string;

    setProtocolVersion(version: string): void {
        this.protocolVersion = version;
    }
}
```

Connect a client and a server over a linked pair of these and both ends end up holding the same version; logging the client end's `protocolVersion` after `connect()` prints:

```
2025-11-25
```

Which version you see depends on the connection's protocol era — see [Protocol versions](../protocol-versions.md).

::: info
`setSupportedProtocolVersions` is the third optional member: `connect()` passes the local side's accepted versions into it, which is how the HTTP server transports know what to allow in the `MCP-Protocol-Version` header.
:::

## Opt into per-request cancellation

Declare `hasPerRequestStream` only on a transport that opens one underlying request per outbound JSON-RPC request, and forward `requestSignal` to that request.

```ts source="../../examples/guides/advanced/custom-transports.examples.ts#transport_perRequest"
readonly hasPerRequestStream = true;

async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options?.headers },
        body: JSON.stringify(message),
        signal: options?.requestSignal
    });
    this.onmessage?.(parseJSONRPCMessage(await response.json()));
}
```

On a 2026-07-28 connection the protocol layer cancels an in-flight request by aborting that request's `requestSignal` instead of sending `notifications/cancelled` — see [Protocol versions](../protocol-versions.md). Single-channel transports — stdio, the loopback above — leave the flag undefined and ignore `requestSignal`; cancellation stays a notification for them.

## Test it against the in-memory pair

`InMemoryTransport` is the reference implementation: the smallest `Transport` the SDK ships, and a known-good baseline for the client and server you drive your own transport with.

```ts source="../../examples/guides/advanced/custom-transports.examples.ts#inMemory_pair"
import { InMemoryTransport } from '@modelcontextprotocol/client';

const [inMemoryClientEnd, inMemoryServerEnd] = InMemoryTransport.createLinkedPair();
```

Run the same client and server over both pairs: the `ping` call above returns the same `content` over `InMemoryTransport` as over the loopback, and anything that differs is a bug in your transport. [Test a server](../testing.md) builds its whole harness on this pair.

## Recap

- A transport is `start`, `send`, `close` plus `onmessage`, `onerror`, `onclose` — nothing else is required.
- `connect()` installs the callbacks, then calls `start()` for you; `close()` must fire `onclose`.
- `ReadBuffer`, `serializeMessage`, and `deserializeMessage` give you the newline-delimited framing the stdio transports use.
- `sessionId`, `setProtocolVersion`, `setSupportedProtocolVersions`, and `hasPerRequestStream` are optional members the SDK uses only when they are present.
- `InMemoryTransport.createLinkedPair()` is the reference implementation and the baseline to test your transport against.
