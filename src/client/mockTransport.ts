import { Transport } from "../shared/transport.js";
import { JSONRPCMessage, RequestId, ServerCapabilities } from "../types.js";
import { AuthInfo } from "../server/auth/types.js";

/**
 * Mock transport for testing client functionality.
 * This implements the Transport interface and adds methods for mocking server responses.
 */
export class MockTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: { authInfo?: AuthInfo }) => void;
  sessionId?: string;

  private _serverCapabilities: ServerCapabilities = {};
  lastRequest?: JSONRPCMessage;

  /**
   * Mocks the server capabilities that would be returned during initialization.
   */
  mockServerCapabilities(capabilities: ServerCapabilities): void {
    this._serverCapabilities = capabilities;
  }

  /**
   * Mocks a response from the server for a specific request.
   * @param request Object containing method and optional params to match
   * @param response The response to return when the request matches
   */
  mockResponse(
    request: { method: string; params?: Record<string, unknown> },
    response: Record<string, unknown>
  ): void {
    const key = this.getRequestKey(request);
    this._responseMap.set(key, response);
  }

  private getRequestKey(request: { method: string; params?: Record<string, unknown> }): string {
    if (!request.params) {
      return request.method;
    }
    // Create a unique key based on method and params
    return `${request.method}:${JSON.stringify(request.params)}`;
  }

  private _responseMap = new Map<string, Record<string, unknown>>();

  async start(): Promise<void> {
    // No-op for mock
  }

  async close(): Promise<void> {
    this.onclose?.();
  }

  async send(message: JSONRPCMessage, _options?: { relatedRequestId?: RequestId, authInfo?: AuthInfo }): Promise<void> {
    // Store the last request for assertions
    this.lastRequest = message;

    // Check if this is a request message (has method and id)
    if ('method' in message && 'id' in message) {
      // Handle initialize request specially
      if (message.method === "initialize") {
        this.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2024-10-07",
            capabilities: this._serverCapabilities,
            serverInfo: {
              name: "mock-server",
              version: "1.0.0",
            },
          },
        });
        return;
      }

      // Check if the method requires a capability that's not available
      if ((message.method === "groups/list" || message.method === "tags/list") &&
          (!this._serverCapabilities.filtering)) {
        // Return an error for unsupported method
        this.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32601,
            message: `Server does not support method: ${message.method}`
          }
        });
        return;
      }

      // For other requests, check if we have a mocked response
      // First try to match with params
      const requestWithParams = {
        method: message.method,
        params: 'params' in message ? message.params as Record<string, unknown> : undefined
      };
      const key = this.getRequestKey(requestWithParams);

      if (this._responseMap.has(key)) {
        const response = this._responseMap.get(key);
        this.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: response || {},
        });
      }
      // Fall back to method-only match if no match with params
      else if (this._responseMap.has(message.method)) {
        const response = this._responseMap.get(message.method);
        this.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: response || {},
        });
      }
    }
  }
}
