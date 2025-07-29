import { Transport } from "./shared/transport.js";
import { JSONRPCMessage, RequestId, MessageExtraInfo } from "./types.js";
import { AuthInfo } from "./server/auth/types.js";

interface QueuedMessage {
  message: JSONRPCMessage;
  extra?: MessageExtraInfo;
}

/**
 * In-memory transport for creating clients and servers that talk to each other within the same process.
 */
export class InMemoryTransport implements Transport {
  private _otherTransport?: InMemoryTransport;
  private _messageQueue: QueuedMessage[] = [];
  private _customContext?: Record<string, unknown>;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
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
      const queuedMessage = this._messageQueue.shift()!;
      // Merge custom context with queued extra info
      const enhancedExtra: MessageExtraInfo = {
        ...queuedMessage.extra,
        customContext: this._customContext
      };
      this.onmessage?.(queuedMessage.message, enhancedExtra);
    }
  }

  async close(): Promise<void> {
    const other = this._otherTransport;
    this._otherTransport = undefined;
    await other?.close();
    this.onclose?.();
  }

  /**
   * Sends a message with optional extra info.
   * This is useful for testing authentication scenarios and custom context.
   * 
   * @deprecated The authInfo parameter is deprecated. Use MessageExtraInfo instead.
   */
  async send(message: JSONRPCMessage, options?: { relatedRequestId?: RequestId, authInfo?: AuthInfo } | MessageExtraInfo): Promise<void> {
    if (!this._otherTransport) {
      throw new Error("Not connected");
    }

    // Handle both old and new API formats
    let extra: MessageExtraInfo | undefined;
    if (options && 'authInfo' in options && !('requestInfo' in options)) {
      // Old API format - convert to new format
      extra = { authInfo: options.authInfo };
    } else if (options && ('requestInfo' in options || 'customContext' in options || 'authInfo' in options)) {
      // New API format
      extra = options as MessageExtraInfo;
    } else if (options && 'authInfo' in options) {
      // Old API with authInfo
      extra = { authInfo: options.authInfo };
    }

    if (this._otherTransport.onmessage) {
      // Merge the other transport's custom context with the extra info
      const enhancedExtra: MessageExtraInfo = {
        ...extra,
        customContext: this._otherTransport._customContext
      };
      this._otherTransport.onmessage(message, enhancedExtra);
    } else {
      this._otherTransport._messageQueue.push({ message, extra });
    }
  }

  /**
   * Sets custom context data that will be passed to all message handlers.
   */
  setCustomContext(context: Record<string, unknown>): void {
    this._customContext = context;
  }
}
