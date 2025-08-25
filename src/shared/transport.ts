import { JSONRPCMessage, MessageExtraInfo, RequestId, InitializeRequest, InitializeResult } from "../types.js";
import { SessionOptions, SessionState } from "./protocol.js";

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Options for sending a JSON-RPC message.
 */
export type TransportSendOptions = {
  /**
   * If present, `relatedRequestId` is used to indicate to the transport which incoming request to associate this outgoing message with.
   */
  relatedRequestId?: RequestId;

  /**
   * The resumption token used to continue long-running requests that were interrupted.
   *
   * This allows clients to reconnect and continue from where they left off, if supported by the transport.
   */
  resumptionToken?: string;

  /**
   * A callback that is invoked when the resumption token changes, if supported by the transport.
   *
   * This allows clients to persist the latest token for potential reconnection.
   */
  onresumptiontoken?: (token: string) => void;
}
/**
 * Describes the minimal contract for a MCP transport that a client or server can communicate over.
 */
export interface Transport {
  /**
   * Starts processing messages on the transport, including any connection steps that might need to be taken.
   *
   * This method should only be called after callbacks are installed, or else messages may be lost.
   *
   * NOTE: This method should not be called explicitly when using Client, Server, or Protocol classes, as they will implicitly call start().
   */
  start(): Promise<void>;

  /**
   * Sends a JSON-RPC message (request or response).
   *
   * If present, `relatedRequestId` is used to indicate to the transport which incoming request to associate this outgoing message with.
   */
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;

  /**
   * Closes the connection.
   */
  close(): Promise<void>;

  /**
   * Callback for when the connection is closed for any reason.
   *
   * This should be invoked when close() is called as well.
   */
  onclose?: () => void;

  /**
   * Callback for when an error occurs.
   *
   * Note that errors are not necessarily fatal; they are used for reporting any kind of exceptional condition out of band.
   */
  onerror?: (error: Error) => void;

  /**
   * Callback for when a message (request or response) is received over the connection.
   *
   * Includes the requestInfo and authInfo if the transport is authenticated.
   *
   * The requestInfo can be used to get the original request information (headers, etc.)
   */
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  /**
   * The session ID for this connection (read-only).
   * Available for backward compatibility only - returns the current session state's sessionId.
   * Session management should be done through server session options, not transport properties.
   */
  readonly sessionId?: string;

  /**
   * Gets legacy session configuration for backward compatibility.
   * Used by server to delegate transport-level session configuration.
   */
  getLegacySessionOptions?: () => SessionOptions | undefined;

  /**
   * Sets the session state reference for HTTP header handling.
   * Used by server to notify transport of session creation.
   */
  setSessionState?: (sessionState: SessionState) => void;

  /**
   * Sets the protocol version used for the connection (called when the initialize response is received).
   */
  setProtocolVersion?: (version: string) => void;

  /**
   * Sets a handler for synchronous initialization processing.
   * Used by HTTP transport to handle initialization before sending response headers.
   */
  setInitializeHandler?: (handler: (request: InitializeRequest) => Promise<InitializeResult>) => void;

  /**
   * Sets a handler for synchronous session termination processing.
   * Used by HTTP transport to handle termination before sending response headers.
   */
  setTerminateHandler?: (handler: (sessionId?: string) => Promise<void>) => void;
}
