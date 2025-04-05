import WebSocket from "ws";
import { JSONRPCMessage } from "../types.js";
import { Transport } from "../shared/transport.js";

/**
 * Server transport for WebSockets: this communicates with a MCP client over a single WebSocket connection.
 *
 * This transport is designed to be used with a WebSocket server implementation (like one built with `ws` or `express-ws`).
 * You would typically create an instance of this transport for each incoming WebSocket connection.
 */
export class WebSocketServerTransport implements Transport {
  private _started = false;

  constructor(private _ws: WebSocket) {}

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  // Arrow functions to bind `this` properly
  private _onMessageHandler = (data: WebSocket.RawData) => {
    try {
      const messageStr = data.toString("utf-8");
      // TODO: Add robust JSON parsing and validation, potentially using zod
      const message: JSONRPCMessage = JSON.parse(messageStr);
      this.onmessage?.(message);
    } catch (error) {
      // Handle JSON parsing errors or other issues
      this.onerror?.(
        error instanceof Error ? error : new Error("Failed to process message"),
      );
    }
  };

  private _onErrorHandler = (error: Error) => {
    this.onerror?.(error);
  };

  private _onCloseHandler = () => {
    this.onclose?.();
    // Clean up listeners after close
    this._ws.off("message", this._onMessageHandler);
    this._ws.off("error", this._onErrorHandler);
    this._ws.off("close", this._onCloseHandler);
  };

  /**
   * Starts listening for messages on the WebSocket.
   */
  async start(): Promise<void> {
    if (this._started) {
      throw new Error(
        "WebSocketServerTransport already started! Ensure start() is called only once per connection.",
      );
    }
    if (this._ws.readyState !== WebSocket.OPEN) {
        throw new Error("WebSocket is not open. Cannot start transport.");
    }

    this._started = true;
    this._ws.on("message", this._onMessageHandler);
    this._ws.on("error", this._onErrorHandler);
    this._ws.on("close", this._onCloseHandler);

    // Unlike stdio, WebSocket connections are typically already established when the transport is created.
    // No explicit connection action needed here, just attaching listeners.
  }

  /**
   * Closes the WebSocket connection.
   */
  async close(): Promise<void> {
    if (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING) {
      this._ws.close();
    }
    // Ensure listeners are removed even if close was called externally or connection was already closed
    this._onCloseHandler();
    this._started = false; // Mark as not started
  }

  /**
   * Sends a JSON-RPC message over the WebSocket connection.
   */
  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("WebSocket is not open. Cannot send message."));
      }

      try {
        const json = JSON.stringify(message);
        this._ws.send(json, (error) => {
          if (error) {
            this.onerror?.(error); // Notify via onerror
            reject(error); // Reject the promise
          } else {
            resolve();
          }
        });
      } catch (error) {
        // Handle JSON stringification errors
        const err = error instanceof Error ? error : new Error("Failed to serialize message");
        this.onerror?.(err);
        reject(err);
      }
    });
  }
}