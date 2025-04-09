import { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "./streamableHttp.js";
import { JSONRPCMessage } from "../types.js";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
// Mock IncomingMessage
function createMockRequest(options: {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
}): IncomingMessage {
  const readable = new Readable();
  readable._read = () => { };
  if (options.body) {
    readable.push(options.body);
    readable.push(null);
  }

  return Object.assign(readable, {
    method: options.method,
    headers: options.headers,
  }) as IncomingMessage;
}

// Mock ServerResponse
function createMockResponse(): jest.Mocked<ServerResponse> {
  const response = {
    writeHead: jest.fn().mockReturnThis(),
    write: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis(),
    on: jest.fn().mockReturnThis(),
    emit: jest.fn().mockReturnThis(),
    getHeader: jest.fn(),
    setHeader: jest.fn(),
  } as unknown as jest.Mocked<ServerResponse>;
  return response;
}

describe("StreamableHTTPServerTransport", () => {
  let transport: StreamableHTTPServerTransport;
  let mockResponse: jest.Mocked<ServerResponse>;
  let mockRequest: string;

  beforeEach(() => {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    mockResponse = createMockResponse();
    mockRequest = JSON.stringify({
      jsonrpc: "2.0",
      method: "test",
      params: {},
      id: 1,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("Session Management", () => {
    it("should generate session ID during initialization", async () => {
      const initializeMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          clientInfo: { name: "test-client", version: "1.0" },
          protocolVersion: "2025-03-26"
        },
        id: "init-1",
      };

      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
        },
        body: JSON.stringify(initializeMessage),
      });

      expect(transport.sessionId).toBeUndefined();
      expect(transport["_initialized"]).toBe(false);

      await transport.handleRequest(req, mockResponse);

      expect(transport.sessionId).toBeDefined();
      expect(transport["_initialized"]).toBe(true);
      expect(mockResponse.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          "mcp-session-id": transport.sessionId,
        })
      );
    });

    it("should reject second initialization request", async () => {
      // First initialize
      const initMessage1: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          clientInfo: { name: "test-client", version: "1.0" },
          protocolVersion: "2025-03-26"
        },
        id: "init-1",
      };

      const req1 = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
        },
        body: JSON.stringify(initMessage1),
      });

      await transport.handleRequest(req1, mockResponse);
      expect(transport["_initialized"]).toBe(true);

      // Reset mock for second request
      mockResponse.writeHead.mockClear();
      mockResponse.end.mockClear();

      // Try second initialize
      const initMessage2: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          clientInfo: { name: "test-client", version: "1.0" },
          protocolVersion: "2025-03-26"
        },
        id: "init-2",
      };

      const req2 = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
        },
        body: JSON.stringify(initMessage2),
      });

      await transport.handleRequest(req2, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(400);
      expect(mockResponse.end).toHaveBeenCalledWith(expect.stringContaining('"message":"Invalid Request: Server already initialized"'));
    });

    it("should reject batch initialize request", async () => {
      const batchInitialize: JSONRPCMessage[] = [
        {
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            clientInfo: { name: "test-client", version: "1.0" },
            protocolVersion: "2025-03-26"
          },
          id: "init-1",
        },
        {
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            clientInfo: { name: "test-client-2", version: "1.0" },
            protocolVersion: "2025-03-26"
          },
          id: "init-2",
        }
      ];

      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
        },
        body: JSON.stringify(batchInitialize),
      });

      await transport.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(400);
      expect(mockResponse.end).toHaveBeenCalledWith(expect.stringContaining('"message":"Invalid Request: Only one initialization request is allowed"'));
    });

    it("should reject invalid session ID", async () => {
      // First initialize the transport
      const initMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          clientInfo: { name: "test-client", version: "1.0" },
          protocolVersion: "2025-03-26"
        },
        id: "init-1",
      };

      const initReq = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
        },
        body: JSON.stringify(initMessage),
      });

      await transport.handleRequest(initReq, mockResponse);
      mockResponse.writeHead.mockClear();

      // Now try with an invalid session ID
      const req = createMockRequest({
        method: "POST",
        headers: {
          "mcp-session-id": "invalid-session-id",
          "accept": "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: mockRequest,
      });

      await transport.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(404);
      expect(mockResponse.end).toHaveBeenCalledWith(expect.stringContaining('"jsonrpc":"2.0"'));
      expect(mockResponse.end).toHaveBeenCalledWith(expect.stringContaining('"message":"Session not found"'));
    });

    it("should reject non-initialization requests without session ID with 400 Bad Request", async () => {
      // First initialize the transport
      const initMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          clientInfo: { name: "test-client", version: "1.0" },
          protocolVersion: "2025-03-26"
        },
        id: "init-1",
      };

      const initReq = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
        },
        body: JSON.stringify(initMessage),
      });

      await transport.handleRequest(initReq, mockResponse);
      mockResponse.writeHead.mockClear();

      // Now try without session ID
      const req = createMockRequest({
        method: "POST",
        headers: {
          "accept": "application/json, text/event-stream",
          "content-type": "application/json",
          // No mcp-session-id header
        },
        body: mockRequest
      });

      await transport.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(400);
      expect(mockResponse.end).toHaveBeenCalledWith(expect.stringContaining('"jsonrpc":"2.0"'));
      expect(mockResponse.end).toHaveBeenCalledWith(expect.stringContaining('"message":"Bad Request: Mcp-Session-Id header is required"'));
    });

    it("should reject requests to uninitialized server", async () => {
      // Create a new transport that hasn't been initialized
      const uninitializedTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      const req = createMockRequest({
        method: "POST",
        headers: {
          "accept": "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": "any-session-id",
        },
        body: mockRequest
      });

      await uninitializedTransport.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(400);
      expect(mockResponse.end).toHaveBeenCalledWith(expect.stringContaining('"message":"Bad Request: Server not initialized"'));
    });

    it("should reject session ID as array", async () => {
      // First initialize the transport
      const initMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          clientInfo: { name: "test-client", version: "1.0" },
          protocolVersion: "2025-03-26"
        },
        id: "init-1",
      };

      const initReq = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
        },
        body: JSON.stringify(initMessage),
      });

      await transport.handleRequest(initReq, mockResponse);
      mockResponse.writeHead.mockClear();

      // Now try with an array session ID
      const req = createMockRequest({
        method: "POST",
        headers: {
          "mcp-session-id": ["session1", "session2"],
          "accept": "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: mockRequest,
      });

      await transport.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(400);
      expect(mockResponse.end).toHaveBeenCalledWith(expect.stringContaining('"message":"Bad Request: Mcp-Session-Id header must be a single value"'));
    });
  });
  describe("Mode without state management", () => {
    let transportWithoutState: StreamableHTTPServerTransport;
    let mockResponse: jest.Mocked<ServerResponse>;

    beforeEach(async () => {
      transportWithoutState = new StreamableHTTPServerTransport({ sessionIdGenerator: () => undefined });
      mockResponse = createMockResponse();

      // Initialize the transport for each test
      const initMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          clientInfo: { name: "test-client", version: "1.0" },
          protocolVersion: "2025-03-26"
        },
        id: "init-1",
      };

      const initReq = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
        },
        body: JSON.stringify(initMessage),
      });

      await transportWithoutState.handleRequest(initReq, mockResponse);
      mockResponse.writeHead.mockClear();
    });

    it("should not include session ID in response headers when in mode without state management", async () => {
      // Use a non-initialization request
      const message: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "test",
        params: {},
        id: 1,
      };

      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
        },
        body: JSON.stringify(message),
      });

      await transportWithoutState.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalled();
      // Extract the headers from writeHead call
      const headers = mockResponse.writeHead.mock.calls[0][1];
      expect(headers).not.toHaveProperty("mcp-session-id");
    });

    it("should not validate session ID in mode without state management", async () => {
      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
          "mcp-session-id": "invalid-session-id", // This would cause a 404 in mode with state management
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "test",
          params: {},
          id: 1
        }),
      });

      await transportWithoutState.handleRequest(req, mockResponse);

      // Should still get 200 OK, not 404 Not Found
      expect(mockResponse.writeHead).toHaveBeenCalledWith(
        200,
        expect.not.objectContaining({
          "mcp-session-id": expect.anything(),
        })
      );
    });

    it("should handle POST requests without session validation in mode without state management", async () => {
      const message: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "test",
        params: {},
        id: 1,
      };

      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
          "mcp-session-id": "non-existent-session-id", // This would be rejected in mode with state management
        },
        body: JSON.stringify(message),
      });

      const onMessageMock = jest.fn();
      transportWithoutState.onmessage = onMessageMock;

      await transportWithoutState.handleRequest(req, mockResponse);

      // Message should be processed despite invalid session ID
      expect(onMessageMock).toHaveBeenCalledWith(message);
    });

    it("should work with a mix of requests with and without session IDs in mode without state management", async () => {
      // First request without session ID
      const req1 = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "test",
          params: {},
          id: "test-id"
        })
      });

      await transportWithoutState.handleRequest(req1, mockResponse);
      expect(mockResponse.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          "Content-Type": "text/event-stream",
        })
      );

      // Reset mock for second request
      mockResponse.writeHead.mockClear();

      // Second request with a session ID (which would be invalid in mode with state management)
      const req2 = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": "some-random-session-id",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "test2",
          params: {},
          id: "test-id-2"
        })
      });

      await transportWithoutState.handleRequest(req2, mockResponse);

      // Should still succeed
      expect(mockResponse.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          "Content-Type": "text/event-stream",
        })
      );
    });

    it("should handle initialization in mode without state management", async () => {
      const transportWithoutState = new StreamableHTTPServerTransport({ sessionIdGenerator: () => undefined });

      // Initialize message
      const initializeMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          clientInfo: { name: "test-client", version: "1.0" },
          protocolVersion: "2025-03-26"
        },
        id: "init-1",
      };

      expect(transportWithoutState.sessionId).toBeUndefined();
      expect(transportWithoutState["_initialized"]).toBe(false);

      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
        },
        body: JSON.stringify(initializeMessage),
      });

      const newResponse = createMockResponse();
      await transportWithoutState.handleRequest(req, newResponse);

      // After initialization, the sessionId should still be undefined
      expect(transportWithoutState.sessionId).toBeUndefined();
      expect(transportWithoutState["_initialized"]).toBe(true);

      // Headers should NOT include session ID in mode without state management
      const headers = newResponse.writeHead.mock.calls[0][1];
      expect(headers).not.toHaveProperty("mcp-session-id");
    });
  });

  describe("Request Handling", () => {
    // Initialize the transport before tests that need initialization
    beforeEach(async () => {
      // For tests that need initialization, initialize here
      const initMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          clientInfo: { name: "test-client", version: "1.0" },
          protocolVersion: "2025-03-26"
        },
        id: "init-1",
      };

      const initReq = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
        },
        body: JSON.stringify(initMessage),
      });

      await transport.handleRequest(initReq, mockResponse);
      mockResponse.writeHead.mockClear();
    });

    it("should reject GET requests for SSE with 405 Method Not Allowed", async () => {
      const req = createMockRequest({
        method: "GET",
        headers: {
          "accept": "application/json, text/event-stream",
          "mcp-session-id": transport.sessionId,
        },
      });

      await transport.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(405, expect.objectContaining({
        "Allow": "POST, DELETE"
      }));
      expect(mockResponse.end).toHaveBeenCalledWith(expect.stringContaining('"jsonrpc":"2.0"'));
      expect(mockResponse.end).toHaveBeenCalledWith(expect.stringContaining('Method not allowed'));
    });

    it("should reject POST requests without proper Accept header", async () => {
      const message: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "test",
        params: {},
        id: 1,
      };

      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-session-id": transport.sessionId,
        },
        body: JSON.stringify(message),
      });

      await transport.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(406);
    });

    it("should properly handle JSON-RPC request messages in POST requests", async () => {
      const message: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "test",
        params: {},
        id: 1,
      };

      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
          "mcp-session-id": transport.sessionId,
        },
        body: JSON.stringify(message),
      });

      const onMessageMock = jest.fn();
      transport.onmessage = onMessageMock;

      await transport.handleRequest(req, mockResponse);

      expect(onMessageMock).toHaveBeenCalledWith(message);
      expect(mockResponse.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          "Content-Type": "text/event-stream",
        })
      );
    });

    it("should properly handle JSON-RPC notification or response messages in POST requests", async () => {
      const notification: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "test",
        params: {},
      };

      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
          "mcp-session-id": transport.sessionId,
        },
        body: JSON.stringify(notification),
      });

      const onMessageMock = jest.fn();
      transport.onmessage = onMessageMock;

      await transport.handleRequest(req, mockResponse);

      expect(onMessageMock).toHaveBeenCalledWith(notification);
      expect(mockResponse.writeHead).toHaveBeenCalledWith(202);
    });

    it("should handle batch notification messages properly with 202 response", async () => {
      const batchMessages: JSONRPCMessage[] = [
        { jsonrpc: "2.0", method: "test1", params: {} },
        { jsonrpc: "2.0", method: "test2", params: {} },
      ];

      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
          "mcp-session-id": transport.sessionId,
        },
        body: JSON.stringify(batchMessages),
      });

      const onMessageMock = jest.fn();
      transport.onmessage = onMessageMock;

      await transport.handleRequest(req, mockResponse);

      expect(onMessageMock).toHaveBeenCalledTimes(2);
      expect(mockResponse.writeHead).toHaveBeenCalledWith(202);
    });

    it("should handle batch request messages with SSE when Accept header includes text/event-stream", async () => {
      const batchMessages: JSONRPCMessage[] = [
        { jsonrpc: "2.0", method: "test1", params: {}, id: "req1" },
        { jsonrpc: "2.0", method: "test2", params: {}, id: "req2" },
      ];

      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "text/event-stream, application/json",
          "mcp-session-id": transport.sessionId,
        },
        body: JSON.stringify(batchMessages),
      });

      const onMessageMock = jest.fn();
      transport.onmessage = onMessageMock;

      mockResponse = createMockResponse(); // Create fresh mock
      await transport.handleRequest(req, mockResponse);

      // Should establish SSE connection
      expect(mockResponse.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          "Content-Type": "text/event-stream"
        })
      );
      expect(onMessageMock).toHaveBeenCalledTimes(2);
      // Stream should remain open until responses are sent
      expect(mockResponse.end).not.toHaveBeenCalled();
    });

    it("should reject unsupported Content-Type", async () => {
      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "accept": "application/json, text/event-stream",
          "mcp-session-id": transport.sessionId,
        },
        body: "test",
      });

      await transport.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(415);
      expect(mockResponse.end).toHaveBeenCalledWith(expect.stringContaining('"jsonrpc":"2.0"'));
    });

    it("should properly handle DELETE requests and close session", async () => {
      // First initialize the transport
      const initMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          clientInfo: { name: "test-client", version: "1.0" },
          protocolVersion: "2025-03-26"
        },
        id: "init-1",
      };

      const initReq = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
        },
        body: JSON.stringify(initMessage),
      });

      await transport.handleRequest(initReq, mockResponse);
      mockResponse.writeHead.mockClear();

      // Now try DELETE with proper session ID
      const req = createMockRequest({
        method: "DELETE",
        headers: {
          "mcp-session-id": transport.sessionId,
        },
      });

      const onCloseMock = jest.fn();
      transport.onclose = onCloseMock;

      await transport.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(200);
      expect(onCloseMock).toHaveBeenCalled();
    });

    it("should reject DELETE requests with invalid session ID", async () => {
      // First initialize the transport
      const initMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          clientInfo: { name: "test-client", version: "1.0" },
          protocolVersion: "2025-03-26"
        },
        id: "init-1",
      };

      const initReq = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
        },
        body: JSON.stringify(initMessage),
      });

      await transport.handleRequest(initReq, mockResponse);
      mockResponse.writeHead.mockClear();

      // Now try DELETE with invalid session ID
      const req = createMockRequest({
        method: "DELETE",
        headers: {
          "mcp-session-id": "invalid-session-id",
        },
      });

      const onCloseMock = jest.fn();
      transport.onclose = onCloseMock;

      await transport.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(404);
      expect(onCloseMock).not.toHaveBeenCalled();
    });
  });

  describe("SSE Response Handling", () => {
    beforeEach(async () => {
      // Initialize the transport
      const initMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          clientInfo: { name: "test-client", version: "1.0" },
          protocolVersion: "2025-03-26"
        },
        id: "init-1",
      };

      const initReq = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
        },
        body: JSON.stringify(initMessage),
      });

      await transport.handleRequest(initReq, mockResponse);
      mockResponse.writeHead.mockClear();
    });

    it("should send response messages as SSE events", async () => {
      // Setup a POST request with JSON-RPC request that accepts SSE
      const requestMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "test",
        params: {},
        id: "test-req-id"
      };

      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
          "mcp-session-id": transport.sessionId
        },
        body: JSON.stringify(requestMessage)
      });

      await transport.handleRequest(req, mockResponse);

      // Send a response to the request
      const responseMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        result: { value: "test-result" },
        id: "test-req-id"
      };

      await transport.send(responseMessage, { relatedRequestId: "test-req-id" });

      // Verify response was sent as SSE event
      expect(mockResponse.write).toHaveBeenCalledWith(
        expect.stringContaining(`event: message\ndata: ${JSON.stringify(responseMessage)}\n\n`)
      );

      // Stream should be closed after sending response
      expect(mockResponse.end).toHaveBeenCalled();
    });

    it("should keep stream open when sending intermediate notifications and requests", async () => {
      // Setup a POST request with JSON-RPC request that accepts SSE
      const requestMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "test",
        params: {},
        id: "test-req-id"
      };

      // Create fresh response for this test
      mockResponse = createMockResponse();

      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
          "mcp-session-id": transport.sessionId
        },
        body: JSON.stringify(requestMessage)
      });

      await transport.handleRequest(req, mockResponse);

      // Send an intermediate notification 
      const notification: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "progress",
        params: { progress: "50%" }
      };

      await transport.send(notification, { relatedRequestId: "test-req-id" });

      // Stream should remain open
      expect(mockResponse.end).not.toHaveBeenCalled();

      // Send the final response
      const responseMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        result: { value: "test-result" },
        id: "test-req-id"
      };

      await transport.send(responseMessage, { relatedRequestId: "test-req-id" });

      // Now stream should be closed
      expect(mockResponse.end).toHaveBeenCalled();
    });
  });

  describe("Message Targeting", () => {
    beforeEach(async () => {
      // Initialize the transport
      const initMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          clientInfo: { name: "test-client", version: "1.0" },
          protocolVersion: "2025-03-26"
        },
        id: "init-1",
      };

      const initReq = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
        },
        body: JSON.stringify(initMessage),
      });

      await transport.handleRequest(initReq, mockResponse);
      mockResponse.writeHead.mockClear();
    });

    it("should send response messages to the connection that sent the request", async () => {
      // Create request with two separate connections
      const requestMessage1: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "test1",
        params: {},
        id: "req-id-1",
      };

      const mockResponse1 = createMockResponse();
      const req1 = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
          "mcp-session-id": transport.sessionId
        },
        body: JSON.stringify(requestMessage1),
      });
      await transport.handleRequest(req1, mockResponse1);

      const requestMessage2: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "test2",
        params: {},
        id: "req-id-2",
      };

      const mockResponse2 = createMockResponse();
      const req2 = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
          "mcp-session-id": transport.sessionId
        },
        body: JSON.stringify(requestMessage2),
      });
      await transport.handleRequest(req2, mockResponse2);

      // Send responses with matching IDs
      const responseMessage1: JSONRPCMessage = {
        jsonrpc: "2.0",
        result: { success: true },
        id: "req-id-1",
      };

      await transport.send(responseMessage1, { relatedRequestId: "req-id-1" });

      const responseMessage2: JSONRPCMessage = {
        jsonrpc: "2.0",
        result: { success: true },
        id: "req-id-2",
      };

      await transport.send(responseMessage2, { relatedRequestId: "req-id-2" });

      // Verify responses were sent to the right connections
      expect(mockResponse1.write).toHaveBeenCalledWith(
        expect.stringContaining(JSON.stringify(responseMessage1))
      );

      expect(mockResponse2.write).toHaveBeenCalledWith(
        expect.stringContaining(JSON.stringify(responseMessage2))
      );

      // Verify responses were not sent to the wrong connections
      const resp1HasResp2 = mockResponse1.write.mock.calls.some(call =>
        typeof call[0] === 'string' && call[0].includes(JSON.stringify(responseMessage2))
      );
      expect(resp1HasResp2).toBe(false);

      const resp2HasResp1 = mockResponse2.write.mock.calls.some(call =>
        typeof call[0] === 'string' && call[0].includes(JSON.stringify(responseMessage1))
      );
      expect(resp2HasResp1).toBe(false);
    });
  });

  describe("Error Handling", () => {
    it("should return 400 error for invalid JSON data", async () => {
      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
        },
        body: "invalid json",
      });

      const onErrorMock = jest.fn();
      transport.onerror = onErrorMock;

      await transport.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(400);
      expect(mockResponse.end).toHaveBeenCalledWith(expect.stringContaining('"jsonrpc":"2.0"'));
      expect(mockResponse.end).toHaveBeenCalledWith(expect.stringContaining('"code":-32700'));
      expect(onErrorMock).toHaveBeenCalled();
    });

    it("should return 400 error for invalid JSON-RPC messages", async () => {
      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
        },
        body: JSON.stringify({ invalid: "message" }),
      });

      const onErrorMock = jest.fn();
      transport.onerror = onErrorMock;

      await transport.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(400);
      expect(mockResponse.end).toHaveBeenCalledWith(expect.stringContaining('"jsonrpc":"2.0"'));
      expect(onErrorMock).toHaveBeenCalled();
    });
  });

  describe("Handling Pre-Parsed Body", () => {
    beforeEach(async () => {
      // Initialize the transport
      const initMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          clientInfo: { name: "test-client", version: "1.0" },
          protocolVersion: "2025-03-26"
        },
        id: "init-1",
      };

      const initReq = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
        },
        body: JSON.stringify(initMessage),
      });

      await transport.handleRequest(initReq, mockResponse);
      mockResponse.writeHead.mockClear();
    });

    it("should accept pre-parsed request body", async () => {
      const message: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "test",
        params: {},
        id: "pre-parsed-test",
      };

      // Create a request without actual body content
      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
          "mcp-session-id": transport.sessionId,
        },
        // No body provided here - it will be passed as parsedBody
      });

      const onMessageMock = jest.fn();
      transport.onmessage = onMessageMock;

      // Pass the pre-parsed body directly
      await transport.handleRequest(req, mockResponse, message);

      // Verify the message was processed correctly
      expect(onMessageMock).toHaveBeenCalledWith(message);
      expect(mockResponse.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          "Content-Type": "text/event-stream",
        })
      );
    });

    it("should handle pre-parsed batch messages", async () => {
      const batchMessages: JSONRPCMessage[] = [
        {
          jsonrpc: "2.0",
          method: "method1",
          params: { data: "test1" },
          id: "batch1"
        },
        {
          jsonrpc: "2.0",
          method: "method2",
          params: { data: "test2" },
          id: "batch2"
        },
      ];

      // Create a request without actual body content
      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
          "mcp-session-id": transport.sessionId,
        },
        // No body provided here - it will be passed as parsedBody
      });

      const onMessageMock = jest.fn();
      transport.onmessage = onMessageMock;

      // Pass the pre-parsed body directly
      await transport.handleRequest(req, mockResponse, batchMessages);

      // Should be called for each message in the batch
      expect(onMessageMock).toHaveBeenCalledTimes(2);
      expect(onMessageMock).toHaveBeenCalledWith(batchMessages[0]);
      expect(onMessageMock).toHaveBeenCalledWith(batchMessages[1]);
    });

    it("should prefer pre-parsed body over request body", async () => {
      const requestBodyMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "fromRequestBody",
        params: {},
        id: "request-body",
      };

      const parsedBodyMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "fromParsedBody",
        params: {},
        id: "parsed-body",
      };

      // Create a request with actual body content
      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
          "mcp-session-id": transport.sessionId,
        },
        body: JSON.stringify(requestBodyMessage),
      });

      const onMessageMock = jest.fn();
      transport.onmessage = onMessageMock;

      // Pass the pre-parsed body directly
      await transport.handleRequest(req, mockResponse, parsedBodyMessage);

      // Should use the parsed body instead of the request body
      expect(onMessageMock).toHaveBeenCalledWith(parsedBodyMessage);
      expect(onMessageMock).not.toHaveBeenCalledWith(requestBodyMessage);
    });
  });
}); 