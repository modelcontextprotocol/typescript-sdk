import { SdkError, SdkErrorCode } from '../errors/sdkErrors.js';
import { StreamDriver } from '../shared/streamDriver.js';
import type { Transport } from '../shared/transport.js';
import type { AuthInfo, JSONRPCMessage, JSONRPCRequest, RequestId } from '../types/index.js';

interface QueuedMessage {
    message: JSONRPCMessage;
    extra?: { authInfo?: AuthInfo };
}

/**
 * In-memory transport for creating clients and servers that talk to each other within the same process.
 *
 * Intended for testing and development. For production in-process connections, use
 * `StreamableHTTPClientTransport` against a local server URL.
 */
export class InMemoryTransport implements Transport {
    private _otherTransport?: InMemoryTransport;
    private _messageQueue: QueuedMessage[] = [];
    private _closed = false;

    /* eslint-disable-next-line unicorn/consistent-function-scoping */
    private readonly _driver = new StreamDriver(m => this.send(m));

    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: { authInfo?: AuthInfo }) => void;
    sessionId?: string;

    /** Client-side: backed by `StreamDriver`. */
    sendAndReceive(request: Omit<JSONRPCRequest, 'jsonrpc' | 'id'>): AsyncIterable<JSONRPCMessage> {
        return this._driver.sendAndReceive(request);
    }

    /**
     * Creates a pair of linked in-memory transports that can communicate with each other. One should be passed to a {@linkcode @modelcontextprotocol/client!client/client.Client | Client} and one to a {@linkcode @modelcontextprotocol/server!server/server.Server | Server}.
     */
    static createLinkedPair(): [InMemoryTransport, InMemoryTransport] {
        const clientTransport = new InMemoryTransport();
        const serverTransport = new InMemoryTransport();
        clientTransport._otherTransport = serverTransport;
        serverTransport._otherTransport = clientTransport;
        return [clientTransport, serverTransport];
    }

    async start(): Promise<void> {
        // Process any messages that were queued before start was called
        while (this._messageQueue.length > 0) {
            const queuedMessage = this._messageQueue.shift()!;
            this._receive(queuedMessage.message, queuedMessage.extra);
        }
    }

    /** Receive path: route to the StreamDriver first; fall through to `onmessage` for unclaimed. */
    private _receive(message: JSONRPCMessage, extra?: { authInfo?: AuthInfo }): void {
        if (this._driver.onMessage(message)) return;
        this.onmessage?.(message, extra);
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        this._driver.close();

        const other = this._otherTransport;
        this._otherTransport = undefined;
        try {
            await other?.close();
        } finally {
            this.onclose?.();
        }
    }

    /**
     * Sends a message with optional auth info.
     * This is useful for testing authentication scenarios.
     */
    async send(message: JSONRPCMessage, options?: { relatedRequestId?: RequestId; authInfo?: AuthInfo }): Promise<void> {
        if (!this._otherTransport) {
            throw new SdkError(SdkErrorCode.NotConnected, 'Not connected');
        }

        if (this._otherTransport.onmessage) {
            this._otherTransport._receive(message, { authInfo: options?.authInfo });
        } else {
            this._otherTransport._messageQueue.push({ message, extra: { authInfo: options?.authInfo } });
        }
    }
}
