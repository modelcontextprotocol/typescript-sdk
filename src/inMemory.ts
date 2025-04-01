import { Transport } from "./shared/transport.js";
import { JSONRPCMessage } from "./types.js";

/**
 * In-memory transport for creating clients and servers that talk to each other within the same process.
 */
export class InMemoryTransport implements Transport {
  private _otherTransport?: InMemoryTransport;
  private _messageQueue: JSONRPCMessage[] = [];
  _messageBuffer: JSONRPCMessage[] = [];

  onclose?: () => void;
  onerror?: (error: Error) => void;
  sessionId?: string;

  /**
   * Creates a pair of linked in-memory transports that can communicate with each other. One should be passed to a Client and one to a Server.
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
      const message = this._messageQueue.shift();
      if (message) {
        this.onmessage?.(message);
      }
    }
  }

  async close(): Promise<void> {
    const other = this._otherTransport;
    this._otherTransport = undefined;
    await other?.close();
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this._otherTransport) {
      throw new Error("Not connected");
    }

    if (this._otherTransport.onmessage) {
      this._otherTransport.onmessage(message);
    } else {
      this._otherTransport._messageQueue.push(message);
    }
  }

  onmessage(message: JSONRPCMessage) {
    this._messageBuffer.push(message)
  }
}
