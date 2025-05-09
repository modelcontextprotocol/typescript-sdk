import { IncomingMessage, ServerResponse } from "node:http";
import {
  StreamableHTTPServerTransport,
  StreamableHTTPServerTransportOptions,
} from "./streamableHttp.js";
import { Transport } from "../shared/transport.js";
import { JSONRPCMessage, RequestId } from "../types.js";

// Container for a Node.js IncomingMessage, optionally with a pre-parsed body.
interface NodeRequestContainer {
  raw: IncomingMessage;
  body?: unknown; // Pre-parsed body by the framework (e.g., Fastify's request.body)
}

// Container for a Node.js ServerResponse.
interface NodeResponseContainer {
  raw: ServerResponse;
}

/**
 * An adapter to use StreamableHTTPServerTransport with Node.js HTTP frameworks
 * that provide access to the raw Node.js request and response objects (e.g., Fastify, Express).
 * This adapter implements the MCP Transport interface, allowing it to be
 * used directly with `McpServer.connect()`.
 */
export class RawHttpServerAdapter implements Transport {
  private mcpTransport: StreamableHTTPServerTransport;

  // Transport interface properties
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  sessionId?: string;

  constructor(options: StreamableHTTPServerTransportOptions) {
    this.mcpTransport = new StreamableHTTPServerTransport(options);

    this.mcpTransport.onmessage = (msg) => {
      this.sessionId = this.mcpTransport.sessionId;
      this.onmessage?.(msg);
    };
    this.mcpTransport.onerror = (err) => this.onerror?.(err);
    this.mcpTransport.onclose = () => {
      this.sessionId = undefined;
      this.onclose?.();
    };
    this.sessionId = this.mcpTransport.sessionId;
  }

  /**
   * Starts the transport. For StreamableHTTPServerTransport, this is largely a no-op
   * as connections are request-driven, but it fulfills the Transport interface.
   */
  public async start(): Promise<void> {
    await this.mcpTransport.start();
    this.sessionId = this.mcpTransport.sessionId;
  }

  /**
   * Closes the transport and cleans up any resources.
   */
  public async close(): Promise<void> {
    await this.mcpTransport.close();
    this.sessionId = undefined;
  }

  /**
   * Sends a JSONRPCMessage through the transport.
   * @param message The message to send.
   * @param options Optional parameters, like relatedRequestId for responses.
   */
  public async send(
    message: JSONRPCMessage,
    options?: { relatedRequestId?: RequestId }
  ): Promise<void> {
    await this.mcpTransport.send(message, options);
    this.sessionId = this.mcpTransport.sessionId;
  }

  /**
   * Handles an incoming HTTP request from a Node.js-based framework
   * and delegates it to the StreamableHTTPServerTransport.
   * @param requestContainer An object containing the raw Node.js IncomingMessage and optionally a pre-parsed body.
   * @param responseContainer An object containing the raw Node.js ServerResponse.
   */
  public async handleNodeRequest(
    requestContainer: NodeRequestContainer,
    responseContainer: NodeResponseContainer
  ): Promise<void> {
    await this.mcpTransport.handleRequest(
      requestContainer.raw,
      responseContainer.raw,
      requestContainer.body
    );
    this.sessionId = this.mcpTransport.sessionId;
  }
}
