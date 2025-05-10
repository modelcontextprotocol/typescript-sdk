import { Transport } from "./shared/transport.js";
import { JSONRPCMessage, RequestId } from "./types.js";
import { AuthInfo } from "./server/auth/types.js";

interface QueuedMessage {
  message: JSONRPCMessage;
  extra?: { authInfo?: AuthInfo };
}

/**
 * In-memory transport for creating clients and servers that talk to each other within the same process.
 */
export class InMemoryTransport implements Transport {
  private _otherTransport?: InMemoryTransport;
  private _messageQueue: QueuedMessage[] = [];

  protected _onclose?: Transport['onclose'];
  protected _onerror?: Transport['onerror'];
  protected _onmessage?: Transport['onmessage'];
  protected _sessionId?: Transport['sessionId'];

  get onmessage() {
    return this._onmessage;
  }

  set onmessage(onmessage: InMemoryTransport['_onmessage']) {
    this._onmessage = onmessage;
  }

  set onerror(onerror: InMemoryTransport['_onerror']) {
    this._onerror = onerror;
  }

  get onerror() {
    return this._onerror;
  }

  set onclose(onclose: InMemoryTransport['_onclose']) {
    this._onclose = onclose;
  }

  get onclose() {
    return this._onclose;
  }

  set sessionId(sessionId: InMemoryTransport['_sessionId']) {
    this._sessionId = sessionId;
  }

  get sessionId() {
    return this._sessionId;
  }


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
      const queuedMessage = this._messageQueue.shift()!;
      this.onmessage?.(queuedMessage.message, queuedMessage.extra);
    }
  }

  async close(): Promise<void> {
    const other = this._otherTransport;
    this._otherTransport = undefined;
    await other?.close();
    this.onclose?.();
  }

  /**
   * Sends a message with optional auth info.
   * This is useful for testing authentication scenarios.
   */
  async send(message: JSONRPCMessage, options?: { relatedRequestId?: RequestId, authInfo?: AuthInfo }): Promise<void> {
    if (!this._otherTransport) {
      throw new Error("Not connected");
    }

    if (this._otherTransport.onmessage) {
      this._otherTransport.onmessage(message, { authInfo: options?.authInfo });
    } else {
      this._otherTransport._messageQueue.push({ message, extra: { authInfo: options?.authInfo } });
    }
  }
}
