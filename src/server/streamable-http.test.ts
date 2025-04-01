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
      const req = createMockRequest({
        method: "GET",
        headers: {
          accept: "text/event-stream"
        },
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
        },
      });

      await transport.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(404);
      // check if the error response is a valid JSON-RPC error format
      expect(mockResponse.end).toHaveBeenCalledWith(expect.stringContaining('"jsonrpc":"2.0"'));
      expect(mockResponse.end).toHaveBeenCalledWith(expect.stringContaining('"error"'));
    });
  });

  describe("Request Handling", () => {
    it("should reject GET requests without Accept: text/event-stream header", async () => {
      const req = createMockRequest({
        method: "GET",
        headers: {},
      });

      await transport.handleRequest(req, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(406);
      expect(mockResponse.end).toHaveBeenCalledWith(expect.stringContaining('"jsonrpc":"2.0"'));
    });

    it("should properly handle GET requests with Accept header and establish SSE connection", async () => {
      const req = createMockRequest({
        method: "GET",
        headers: {
          accept: "text/event-stream",
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
        method: "test",
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
        method: "test",
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
        headers: {},
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
      // Establish first connection with Accept header
      const req1 = createMockRequest({
        method: "GET",
        headers: {
          "accept": "text/event-stream"
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
}); 