/**
 * Companion example for `docs/advanced/custom-transports.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness below the
 * regions connects a client and a server over the loopback transport and
 * produces the output the page quotes verbatim.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/advanced/custom-transports.examples.ts        # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
//#region transport_loopback
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
//#endregion transport_loopback

// "Connect it like a built-in transport" — produces the output the page quotes.
//#region connect_loopback
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
//#endregion connect_loopback

// "Frame messages over a byte stream" — typechecked, not run (it needs a real
// socket). The runnable proof on this page is the loopback transport above.
//#region transport_socket
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
//#endregion transport_socket

// "Report a session ID and the negotiated version".
//#region transport_session
export class SessionLoopbackTransport extends LoopbackTransport {
    sessionId?: string;

    protocolVersion?: string;

    setProtocolVersion(version: string): void {
        this.protocolVersion = version;
    }
}
//#endregion transport_session

// "Opt into per-request cancellation" — typechecked, not run.
import type { TransportSendOptions } from '@modelcontextprotocol/server';
import { parseJSONRPCMessage } from '@modelcontextprotocol/server';

export class HttpPostTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    constructor(private readonly endpoint: URL) {}

    //#region transport_perRequest
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
    //#endregion transport_perRequest

    async start(): Promise<void> {}

    async close(): Promise<void> {
        this.onclose?.();
    }
}

// ---------------------------------------------------------------------------
// Harness (not shown on the page). Drives the remaining claims the page makes
// and throws (non-zero exit) if any of them is false.
// ---------------------------------------------------------------------------

await client.close();
await server.close();

// "Report a session ID and the negotiated version" — the version the page quotes.
const sessionServer = new McpServer({ name: 'loopback-demo', version: '1.0.0' });
const sessionClient = new Client({ name: 'loopback-client', version: '1.0.0' });

const sessionServerEnd = new SessionLoopbackTransport();
const sessionClientEnd = new SessionLoopbackTransport();
LoopbackTransport.link(sessionServerEnd, sessionClientEnd);

await sessionServer.connect(sessionServerEnd);
await sessionClient.connect(sessionClientEnd);

console.log(sessionClientEnd.protocolVersion);
if (sessionServerEnd.protocolVersion !== sessionClientEnd.protocolVersion) {
    throw new Error(
        `custom-transports.md claim failed: server end negotiated ${sessionServerEnd.protocolVersion}, client end ${sessionClientEnd.protocolVersion}`
    );
}

await sessionClient.close();
await sessionServer.close();

// "Test it against the in-memory pair" — the reference transport returns the
// same result the loopback produced.
const referenceServer = new McpServer({ name: 'loopback-demo', version: '1.0.0' });
referenceServer.registerTool('ping', { description: 'Reply with pong' }, async () => ({
    content: [{ type: 'text', text: 'pong' }]
}));
const referenceClient = new Client({ name: 'loopback-client', version: '1.0.0' });

//#region inMemory_pair
import { InMemoryTransport } from '@modelcontextprotocol/client';

const [inMemoryClientEnd, inMemoryServerEnd] = InMemoryTransport.createLinkedPair();
//#endregion inMemory_pair

await referenceServer.connect(inMemoryServerEnd);
await referenceClient.connect(inMemoryClientEnd);

const referenceResult = await referenceClient.callTool({ name: 'ping' });
if (JSON.stringify(referenceResult.content) !== JSON.stringify(result.content)) {
    throw new Error(`custom-transports.md claim failed: in-memory result ${JSON.stringify(referenceResult.content)}`);
}

await referenceClient.close();
await referenceServer.close();
