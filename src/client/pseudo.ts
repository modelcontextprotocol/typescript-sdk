import { JSONRPCMessage } from "../types.js";
import { Transport } from "../shared/transport.js";
import { McpServer } from "src/server/mcp.js";

/**
 * Pseudo-Transport for testing or embedding: connects an MCP client
 * directly to an McpServer instance within the same process, bypassing
 * actual network or stdio communication.
 *
 * Instantiate this with an McpServer, then pass this transport instance
 * to your MCP client's connect method.
 */
export class PseudoTransport implements Transport {
  private _started = false;
  private _mcpServer: McpServer;
  private _isServerConnected = false;

  private _clientMessageHandler?: (message: JSONRPCMessage) => void;
  private _clientErrorHandler?: (error: Error) => void;
  private _clientCloseHandler?: () => void;

  private _serverMessageHandler?: (message: JSONRPCMessage) => void;

  /**
   * Creates a PseudoTransport instance linked to a specific McpServer.
   * @param mcpServer The McpServer instance to communicate with.
   */
  constructor(mcpServer: McpServer) {
    if (!mcpServer) {
      throw new Error("McpServer instance is required for PseudoTransport.");
    }
    this._mcpServer = mcpServer;
  }

  set onmessage(handler: ((message: JSONRPCMessage) => void) | undefined) {
    this._clientMessageHandler = handler;
  }
  get onmessage(): ((message: JSONRPCMessage) => void) | undefined {
    return this._clientMessageHandler;
  }

  set onerror(handler: ((error: Error) => void) | undefined) {
    this._clientErrorHandler = handler;
  }
  get onerror(): ((error: Error) => void) | undefined {
    return this._clientErrorHandler;
  }

  set onclose(handler: (() => void) | undefined) {
    this._clientCloseHandler = handler;
  }
  get onclose(): (() => void) | undefined {
    return this._clientCloseHandler;
  }

  /**
   * Starts the pseudo-connection. This internally connects the transport
   * to the provided McpServer instance and ensures handlers are set up
   * before resolving.
   */
  async start(): Promise<void> {
    if (this._started) {
      throw new Error("PseudoTransport already started!");
    }

    const self = this;
    const serverFacingTransportProxy: Transport = {
      set onmessage(handler: ((message: JSONRPCMessage) => void) | undefined) {
        self._serverMessageHandler = handler;
        if (handler) {
          self._isServerConnected = true;
        } else {
          self._isServerConnected = false;
        }
      },
      get onmessage(): ((message: JSONRPCMessage) => void) | undefined {
        return self._serverMessageHandler;
      },
      send: async (message: JSONRPCMessage): Promise<void> => {
        if (self._clientMessageHandler) {
          setTimeout(() => {
            try {
              self._clientMessageHandler!(message);
            } catch (error) {
              self._clientErrorHandler?.(error instanceof Error ? error : new Error(String(error)));
            }
          }, 0);
        }
      },
      start: async (): Promise<void> => {},
      close: async (): Promise<void> => {
        self._isServerConnected = false;
      },
      onerror: undefined,
      onclose: undefined,
    };

    try {
      await this._mcpServer.connect(serverFacingTransportProxy);
      if (!this._serverMessageHandler) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (!this._serverMessageHandler) {
          console.warn("[PseudoTransport] McpServer did NOT set a message handler after connect completed. Client requests might fail.");
        }
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error("Failed to connect internal McpServer");
      this._clientErrorHandler?.(err);
      this._started = false;
      throw err;
    }

    this._started = true;
  }

  /**
   * Closes the pseudo-connection. Notifies the client.
   */
  async close(): Promise<void> {
    if (!this._started) {
      return Promise.resolve();
    }
    this._started = false;
    this._isServerConnected = false;

    const clientCloseHandler = this._clientCloseHandler;
    this._serverMessageHandler = undefined;
    this._clientMessageHandler = undefined;
    this._clientErrorHandler = undefined;
    this._clientCloseHandler = undefined;

    setTimeout(() => clientCloseHandler?.(), 0);

    return Promise.resolve();
  }

  /**
   * Sends a message FROM the CLIENT TO the McpServer.
   * This will invoke the message handler the McpServer registered.
   * @param message The JSON-RPC message from the client.
   */
  send(message: JSONRPCMessage): Promise<void> {
    if (!this._started) {
      return Promise.reject(new Error("PseudoTransport is not started."));
    }
    if (!this._serverMessageHandler || !this._isServerConnected) {
      return Promise.reject(new Error("PseudoTransport: McpServer handler not available or server not connected."));
    }

    const serverHandler = this._serverMessageHandler;

    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          serverHandler(message);
          resolve();
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this._clientErrorHandler?.(err);
          reject(err);
        }
      }, 0);
    });
  }
}
