import { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "./streamable-http.js";
import { JSONRPCMessage } from "../types.js";
import { Readable } from "node:stream";

// Mock IncomingMessage
function createMockRequest(options: {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
}): IncomingMessage {
  const readable = new Readable();
  readable._read = () => {};
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
  const endpoint = "/mcp";
  let transport: StreamableHTTPServerTransport;
  let mockResponse: jest.Mocked<ServerResponse>;

  beforeEach(() => {
    transport = new StreamableHTTPServerTransport(endpoint);
    mockResponse = createMockResponse();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("Session Management", () => {
    it("should generate a valid session ID", () => {
      expect(transport.sessionId).toBeTruthy();
      expect(typeof transport.sessionId).toBe("string");
    });

    it("should include session ID in response headers", async () => {
      // Use POST with initialize method to avoid session ID requirement
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
          "accept": "application/json",
        },
        body: JSON.stringify(initializeMessage),
      });

      await transport.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          "mcp-session-id": transport.sessionId,
        })
      );
    });

    it("should reject invalid session ID", async () => {
      const req = createMockRequest({
        method: "GET",
        headers: {
          "mcp-session-id": "invalid-session-id",
          "accept": "text/event-stream"
        },
      });

      await transport.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(404, {});
      // check if the error response is a valid JSON-RPC error format
      expect(mockResponse.end).toHaveBeenCalledWith(expect.stringContaining('"jsonrpc":"2.0"'));
      expect(mockResponse.end).toHaveBeenCalledWith(expect.stringContaining('"error"'));
    });

    it("should reject non-initialization requests without session ID with 400 Bad Request", async () => {
      const req = createMockRequest({
        method: "GET",
        headers: {
          accept: "text/event-stream",
          // No mcp-session-id header
        },
      });

      await transport.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(400, {});
      expect(mockResponse.end).toHaveBeenCalledWith(expect.stringContaining('"jsonrpc":"2.0"'));
      expect(mockResponse.end).toHaveBeenCalledWith(expect.stringContaining('"message":"Bad Request: Mcp-Session-Id header is required"'));
    });

    it("should always include session ID in initialization response even in stateless mode", async () => {
      // Create a stateless transport for this test
      const statelessTransport = new StreamableHTTPServerTransport(endpoint, { enableSessionManagement: false });
      
      // Create an initialization request
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
          "accept": "application/json",
        },
        body: JSON.stringify(initializeMessage),
      });

      await statelessTransport.handleRequest(req, mockResponse);
      
      // In stateless mode, session ID should also be included for initialize responses
      expect(mockResponse.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          "mcp-session-id": statelessTransport.sessionId,
        })
      );
    });
  });

  describe("Stateless Mode", () => {
    let statelessTransport: StreamableHTTPServerTransport;
    let mockResponse: jest.Mocked<ServerResponse>;

    beforeEach(() => {
      statelessTransport = new StreamableHTTPServerTransport(endpoint, { enableSessionManagement: false });
      mockResponse = createMockResponse();
    });

    it("should not include session ID in response headers when in stateless mode", async () => {
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
          "accept": "application/json",
        },
        body: JSON.stringify(message),
      });

      await statelessTransport.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalled();
      // Extract the headers from writeHead call
      const headers = mockResponse.writeHead.mock.calls[0][1];
      expect(headers).not.toHaveProperty("mcp-session-id");
    });

    it("should not validate session ID in stateless mode", async () => {
      const req = createMockRequest({
        method: "GET",
        headers: {
          accept: "text/event-stream",
          "mcp-session-id": "invalid-session-id", // This would cause a 404 in stateful mode
        },
      });

      await statelessTransport.handleRequest(req, mockResponse);

      // Should still get 200 OK, not 404 Not Found
      expect(mockResponse.writeHead).toHaveBeenCalledWith(
        200,
        expect.not.objectContaining({
          "mcp-session-id": expect.anything(),
        })
      );
    });

    it("should handle POST requests without session validation in stateless mode", async () => {
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
          "accept": "application/json",
          "mcp-session-id": "non-existent-session-id", // This would be rejected in stateful mode
        },
        body: JSON.stringify(message),
      });

      const onMessageMock = jest.fn();
      statelessTransport.onmessage = onMessageMock;

      await statelessTransport.handleRequest(req, mockResponse);

      // Message should be processed despite invalid session ID
      expect(onMessageMock).toHaveBeenCalledWith(message);
    });

    it("should work with a mix of requests with and without session IDs in stateless mode", async () => {
      // First request without session ID
      const req1 = createMockRequest({
        method: "GET",
        headers: {
          accept: "text/event-stream",
        },
      });

      await statelessTransport.handleRequest(req1, mockResponse);
      expect(mockResponse.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          "Content-Type": "text/event-stream",
        })
      );

      // Reset mock for second request
      mockResponse.writeHead.mockClear();

      // Second request with a session ID (which would be invalid in stateful mode)
      const req2 = createMockRequest({
        method: "GET",
        headers: {
          accept: "text/event-stream",
          "mcp-session-id": "some-random-session-id",
        },
      });

      await statelessTransport.handleRequest(req2, mockResponse);
      
      // Should still succeed
      expect(mockResponse.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          "Content-Type": "text/event-stream",
        })
      );
    });

    it("should handle initialization requests properly in both modes", async () => {
      // Initialize message that would typically be sent during initialization
      const initializeMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "initialize",
        params: { 
          clientInfo: { name: "test-client", version: "1.0" },
          protocolVersion: "2025-03-26"
        },
        id: "init-1",
      };

      // Test stateful transport (default)
      const statefulReq = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
        },
        body: JSON.stringify(initializeMessage),
      });

      await transport.handleRequest(statefulReq, mockResponse);
      
      // In stateful mode, session ID should be included in the response header
      expect(mockResponse.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          "mcp-session-id": transport.sessionId,
        })
      );

      // Reset mocks for stateless test
      mockResponse.writeHead.mockClear();

      // Test stateless transport
      const statelessReq = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
        },
        body: JSON.stringify(initializeMessage),
      });

      await statelessTransport.handleRequest(statelessReq, mockResponse);
      
      // In stateless mode, session ID should also be included for initialize responses
      const headers = mockResponse.writeHead.mock.calls[0][1];
      expect(headers).toHaveProperty("mcp-session-id", statelessTransport.sessionId);
    });
  });

  describe("Request Handling", () => {
    it("should reject GET requests without Accept: text/event-stream header", async () => {
      const req = createMockRequest({
        method: "GET",
        headers: {
          "mcp-session-id": transport.sessionId,
        },
      });

      await transport.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(406, {});
      expect(mockResponse.end).toHaveBeenCalledWith(expect.stringContaining('"jsonrpc":"2.0"'));
    });

    it("should properly handle GET requests with Accept header and establish SSE connection", async () => {
      const req = createMockRequest({
        method: "GET",
        headers: {
          "accept": "text/event-stream",
          "mcp-session-id": transport.sessionId,
        },
      });

      await transport.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        })
      );
    });

    it("should reject POST requests without proper Accept header", async () => {
      const message: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "initialize", // Use initialize to bypass session ID check
        params: {},
        id: 1,
      };

      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(message),
      });

      await transport.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(406);
    });

    it("should properly handle JSON-RPC request messages in POST requests", async () => {
      const message: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "initialize", // Use initialize to bypass session ID check
        params: {},
        id: 1,
      };

      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "text/event-stream",
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

    it("should handle batch messages properly", async () => {
      const batchMessages: JSONRPCMessage[] = [
        { jsonrpc: "2.0", method: "test1", params: {} },
        { jsonrpc: "2.0", method: "test2", params: {} },
      ];

      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
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

    it("should reject unsupported Content-Type", async () => {
      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "accept": "application/json",
          "mcp-session-id": transport.sessionId,
        },
        body: "test",
      });

      await transport.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(415);
      expect(mockResponse.end).toHaveBeenCalledWith(expect.stringContaining('"jsonrpc":"2.0"'));
    });

    it("should properly handle DELETE requests and close session", async () => {
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
  });

  describe("Message Replay", () => {
    it("should replay messages after specified Last-Event-ID", async () => {
      // Establish first connection with Accept header and session ID
      const req1 = createMockRequest({
        method: "GET",
        headers: {
          "accept": "text/event-stream",
          "mcp-session-id": transport.sessionId
        },
      });
      await transport.handleRequest(req1, mockResponse);

      // Send a message to first connection
      const message1: JSONRPCMessage = {
        jsonrpc: "2.0", 
        method: "test1", 
        params: {}, 
        id: 1
      };
      
      await transport.send(message1);
      
      // Get message ID (captured from write call)
      const writeCall = mockResponse.write.mock.calls[0][0] as string;
      const idMatch = writeCall.match(/id: ([a-f0-9-]+)/);
      if (!idMatch) {
        throw new Error("Message ID not found in write call");
      }
      const lastEventId = idMatch[1];

      // Create a second connection with last-event-id
      const mockResponse2 = createMockResponse();
      const req2 = createMockRequest({
        method: "GET",
        headers: {
          "accept": "text/event-stream",
          "last-event-id": lastEventId,
          "mcp-session-id": transport.sessionId
        },
      });

      await transport.handleRequest(req2, mockResponse2);

      // Send a second message
      const message2: JSONRPCMessage = {
        jsonrpc: "2.0", 
        method: "test2", 
        params: {}, 
        id: 2
      };
      
      await transport.send(message2);

      // Verify the second message was received by both connections
      expect(mockResponse.write).toHaveBeenCalledWith(
        expect.stringContaining(JSON.stringify(message1))
      );
      expect(mockResponse2.write).toHaveBeenCalledWith(
        expect.stringContaining(JSON.stringify(message2))
      );
    });
  });

  describe("Message Targeting", () => {
    it("should send response messages to the connection that sent the request", async () => {
      // Create two connections
      const mockResponse1 = createMockResponse();
      const req1 = createMockRequest({
        method: "GET",
        headers: {
          "accept": "text/event-stream",
        },
      });
      await transport.handleRequest(req1, mockResponse1);

      const mockResponse2 = createMockResponse();
      const req2 = createMockRequest({
        method: "GET",
        headers: {
          "accept": "text/event-stream",
        },
      });
      await transport.handleRequest(req2, mockResponse2);

      // Send a request through the first connection
      const requestMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "test",
        params: {},
        id: "test-id",
      };
      
      const reqPost = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "text/event-stream",
        },
        body: JSON.stringify(requestMessage),
      });
      
      await transport.handleRequest(reqPost, mockResponse1);
      
      // Send a response with matching ID
      const responseMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        result: { success: true },
        id: "test-id",
      };
      
      await transport.send(responseMessage);
      
      // Verify response was sent to the right connection
      expect(mockResponse1.write).toHaveBeenCalledWith(
        expect.stringContaining(JSON.stringify(responseMessage))
      );
      
      // Check if write was called with this exact message on the second connection
      const writeCallsOnSecondConn = mockResponse2.write.mock.calls.filter(call => 
        typeof call[0] === 'string' && call[0].includes(JSON.stringify(responseMessage))
      );
      
      // Verify the response wasn't broadcast to all connections
      expect(writeCallsOnSecondConn.length).toBe(0);
    });
  });

  describe("Error Handling", () => {
    it("should handle invalid JSON data", async () => {
      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
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

    it("should handle invalid JSON-RPC messages", async () => {
      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
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
    it("should accept pre-parsed request body", async () => {
      const message: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "initialize",
        params: { 
          clientInfo: { name: "test-client", version: "1.0" },
          protocolVersion: "2025-03-26"
        },
        id: "pre-parsed-test",
      };

      // Create a request without actual body content
      const req = createMockRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
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
          "Content-Type": "application/json",
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
          "accept": "text/event-stream",
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
          "accept": "application/json",
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

  describe("Custom Headers", () => {
    const customHeaders = {
      "X-Custom-Header": "custom-value",
      "X-API-Version": "1.0",
      "Access-Control-Allow-Origin": "*"
    };

    let transportWithHeaders: StreamableHTTPServerTransport;
    let mockResponse: jest.Mocked<ServerResponse>;

    beforeEach(() => {
      transportWithHeaders = new StreamableHTTPServerTransport(endpoint, { customHeaders });
      mockResponse = createMockResponse();
    });

    it("should include custom headers in SSE response", async () => {
      const req = createMockRequest({
        method: "GET",
        headers: {
          accept: "text/event-stream",
          "mcp-session-id": transportWithHeaders.sessionId
        },
      });

      await transportWithHeaders.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          ...customHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "mcp-session-id": transportWithHeaders.sessionId
        })
      );
    });

    it("should include custom headers in JSON response", async () => {
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
          "accept": "application/json",
          "mcp-session-id": transportWithHeaders.sessionId
        },
        body: JSON.stringify(message),
      });

      await transportWithHeaders.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          ...customHeaders,
          "Content-Type": "application/json",
          "mcp-session-id": transportWithHeaders.sessionId
        })
      );
    });

    it("should include custom headers in error responses", async () => {
      const req = createMockRequest({
        method: "GET",
        headers: {
          accept: "text/event-stream",
          "mcp-session-id": "invalid-session-id"
        },
      });

      await transportWithHeaders.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(
        404,
        expect.objectContaining(customHeaders)
      );
    });

    it("should not override essential headers with custom headers", async () => {
      const transportWithConflictingHeaders = new StreamableHTTPServerTransport(endpoint, {
        customHeaders: {
          "Content-Type": "text/plain", // 尝试覆盖必要的 Content-Type 头
          "X-Custom-Header": "custom-value"
        }
      });

      const req = createMockRequest({
        method: "GET",
        headers: {
          accept: "text/event-stream",
          "mcp-session-id": transportWithConflictingHeaders.sessionId
        },
      });

      await transportWithConflictingHeaders.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          "Content-Type": "text/event-stream", // 应该保持原有的 Content-Type
          "X-Custom-Header": "custom-value"
        })
      );
    });

    it("should work with empty custom headers", async () => {
      const transportWithoutHeaders = new StreamableHTTPServerTransport(endpoint);
      
      const req = createMockRequest({
        method: "GET",
        headers: {
          accept: "text/event-stream",
          "mcp-session-id": transportWithoutHeaders.sessionId
        },
      });

      await transportWithoutHeaders.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "mcp-session-id": transportWithoutHeaders.sessionId
        })
      );
    });
  });
}); 