import { StreamableHTTPClientTransport, StreamableHTTPReconnectionOptions } from "./streamableHttp.js";
import { JSONRPCMessage } from "../types.js";


describe("StreamableHTTPClientTransport", () => {
  let transport: StreamableHTTPClientTransport;

  beforeEach(() => {
    transport = new StreamableHTTPClientTransport(new URL("http://localhost:1234/mcp"));
    jest.spyOn(global, "fetch");
  });

  afterEach(async () => {
    await transport.close().catch(() => { });
    jest.clearAllMocks();
  });

  it("should send JSON-RPC messages via POST", async () => {
    const message: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "test",
      params: {},
      id: "test-id"
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 202,
      headers: new Headers(),
    });

    await transport.send(message);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
        body: JSON.stringify(message)
      })
    );
  });

  it("should send batch messages", async () => {
    const messages: JSONRPCMessage[] = [
      { jsonrpc: "2.0", method: "test1", params: {}, id: "id1" },
      { jsonrpc: "2.0", method: "test2", params: {}, id: "id2" }
    ];

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: null
    });

    await transport.send(messages);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
        body: JSON.stringify(messages)
      })
    );
  });

  it("should store session ID received during initialization", async () => {
    const message: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        clientInfo: { name: "test-client", version: "1.0" },
        protocolVersion: "2025-03-26"
      },
      id: "init-id"
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream", "mcp-session-id": "test-session-id" }),
    });

    await transport.send(message);

    // Send a second message that should include the session ID
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 202,
      headers: new Headers()
    });

    await transport.send({ jsonrpc: "2.0", method: "test", params: {} } as JSONRPCMessage);

    // Check that second request included session ID header
    const calls = (global.fetch as jest.Mock).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[1].headers).toBeDefined();
    expect(lastCall[1].headers.get("mcp-session-id")).toBe("test-session-id");
  });

  it("should handle 404 response when session expires", async () => {
    const message: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "test",
      params: {},
      id: "test-id"
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: () => Promise.resolve("Session not found"),
      headers: new Headers()
    });

    const errorSpy = jest.fn();
    transport.onerror = errorSpy;

    await expect(transport.send(message)).rejects.toThrow("Error POSTing to endpoint (HTTP 404)");
    expect(errorSpy).toHaveBeenCalled();
  });

  it("should handle non-streaming JSON response", async () => {
    const message: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "test",
      params: {},
      id: "test-id"
    };

    const responseMessage: JSONRPCMessage = {
      jsonrpc: "2.0",
      result: { success: true },
      id: "test-id"
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve(responseMessage)
    });

    const messageSpy = jest.fn();
    transport.onmessage = messageSpy;

    await transport.send(message);

    expect(messageSpy).toHaveBeenCalledWith(responseMessage);
  });

  it("should attempt initial GET connection and handle 405 gracefully", async () => {
    // Mock the server not supporting GET for SSE (returning 405)
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 405,
      statusText: "Method Not Allowed"
    });

    // We expect the 405 error to be caught and handled gracefully
    // This should not throw an error that breaks the transport
    await transport.start();
    await expect(transport["_startOrAuthSse"]({})).resolves.not.toThrow("Failed to open SSE stream: Method Not Allowed");
    // Check that GET was attempted
    expect(global.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        method: "GET",
        headers: expect.any(Headers)
      })
    );

    // Verify transport still works after 405
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 202,
      headers: new Headers()
    });

    await transport.send({ jsonrpc: "2.0", method: "test", params: {} } as JSONRPCMessage);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("should handle successful initial GET connection for SSE", async () => {
    // Set up readable stream for SSE events
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // Send a server notification via SSE
        const event = "event: message\ndata: {\"jsonrpc\": \"2.0\", \"method\": \"serverNotification\", \"params\": {}}\n\n";
        controller.enqueue(encoder.encode(event));
      }
    });

    // Mock successful GET connection
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: stream
    });

    const messageSpy = jest.fn();
    transport.onmessage = messageSpy;

    await transport.start();
    await transport["_startOrAuthSse"]({});

    // Give time for the SSE event to be processed
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(messageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: "2.0",
        method: "serverNotification",
        params: {}
      })
    );
  });

  it("should handle multiple concurrent SSE streams", async () => {
    // Mock two POST requests that return SSE streams
    const makeStream = (id: string) => {
      const encoder = new TextEncoder();
      return new ReadableStream({
        start(controller) {
          const event = `event: message\ndata: {"jsonrpc": "2.0", "result": {"id": "${id}"}, "id": "${id}"}\n\n`;
          controller.enqueue(encoder.encode(event));
        }
      });
    };

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: makeStream("request1")
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: makeStream("request2")
      });

    const messageSpy = jest.fn();
    transport.onmessage = messageSpy;

    // Send two concurrent requests
    await Promise.all([
      transport.send({ jsonrpc: "2.0", method: "test1", params: {}, id: "request1" }),
      transport.send({ jsonrpc: "2.0", method: "test2", params: {}, id: "request2" })
    ]);

    // Give time for SSE processing
    await new Promise(resolve => setTimeout(resolve, 100));

    // Both streams should have delivered their messages
    expect(messageSpy).toHaveBeenCalledTimes(2);

    // Verify received messages without assuming specific order
    expect(messageSpy.mock.calls.some(call => {
      const msg = call[0];
      return msg.id === "request1" && msg.result?.id === "request1";
    })).toBe(true);

    expect(messageSpy.mock.calls.some(call => {
      const msg = call[0];
      return msg.id === "request2" && msg.result?.id === "request2";
    })).toBe(true);
  });

  it("should support custom reconnection options", () => {
    // Create a transport with custom reconnection options
    transport = new StreamableHTTPClientTransport(new URL("http://localhost:1234/mcp"), {
      reconnectionOptions: {
        initialReconnectionDelay: 500,
        maxReconnectionDelay: 10000,
        reconnectionDelayGrowFactor: 2,
        maxRetries: 5,
      }
    });

    // Verify options were set correctly (checking implementation details)
    // Access private properties for testing
    const transportInstance = transport as unknown as {
      _reconnectionOptions: StreamableHTTPReconnectionOptions;
    };
    expect(transportInstance._reconnectionOptions.initialReconnectionDelay).toBe(500);
    expect(transportInstance._reconnectionOptions.maxRetries).toBe(5);
  });

  it("should pass lastEventId when reconnecting", async () => {
    // Create a fresh transport
    transport = new StreamableHTTPClientTransport(new URL("http://localhost:1234/mcp"));

    // Mock fetch to verify headers sent
    const fetchSpy = global.fetch as jest.Mock;
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: new ReadableStream()
    });

    // Call the reconnect method directly with a lastEventId
    await transport.start();
    // Type assertion to access private method
    const transportWithPrivateMethods = transport as unknown as {
      _startOrAuthSse: (options: { resumptionToken?: string }) => Promise<void>
    };
    await transportWithPrivateMethods._startOrAuthSse({ resumptionToken: "test-event-id" });

    // Verify fetch was called with the lastEventId header
    expect(fetchSpy).toHaveBeenCalled();
    const fetchCall = fetchSpy.mock.calls[0];
    const headers = fetchCall[1].headers;
    expect(headers.get("last-event-id")).toBe("test-event-id");
  });

  it("should throw error when invalid content-type is received", async () => {
    // Clear any previous state from other tests
    jest.clearAllMocks();

    // Create a fresh transport instance
    transport = new StreamableHTTPClientTransport(new URL("http://localhost:1234/mcp"));

    const message: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "test",
      params: {},
      id: "test-id"
    };

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("invalid text response"));
        controller.close();
      }
    });

    const errorSpy = jest.fn();
    transport.onerror = errorSpy;

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      body: stream
    });

    await transport.start();
    await expect(transport.send(message)).rejects.toThrow("Unexpected content type: text/plain");
    expect(errorSpy).toHaveBeenCalled();
  });


  it("should always send specified custom headers", async () => {
    const requestInit = {
      headers: {
        "X-Custom-Header": "CustomValue"
      }
    };
    transport = new StreamableHTTPClientTransport(new URL("http://localhost:1234/mcp"), {
      requestInit: requestInit
    });

    let actualReqInit: RequestInit = {};

    ((global.fetch as jest.Mock)).mockImplementation(
      async (_url, reqInit) => {
        actualReqInit = reqInit;
        return new Response(null, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
    );

    await transport.start();

    await transport["_startOrAuthSse"]({});
    expect((actualReqInit.headers as Headers).get("x-custom-header")).toBe("CustomValue");

    requestInit.headers["X-Custom-Header"] = "SecondCustomValue";

    await transport.send({ jsonrpc: "2.0", method: "test", params: {} } as JSONRPCMessage);
    expect((actualReqInit.headers as Headers).get("x-custom-header")).toBe("SecondCustomValue");

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });


  it("should have exponential backoff with configurable maxRetries", () => {
    // This test verifies the maxRetries and backoff calculation directly

    // Create transport with specific options for testing
    transport = new StreamableHTTPClientTransport(new URL("http://localhost:1234/mcp"), {
      reconnectionOptions: {
        initialReconnectionDelay: 100,
        maxReconnectionDelay: 5000,
        reconnectionDelayGrowFactor: 2,
        maxRetries: 3,
      }
    });

    // Get access to the internal implementation
    const getDelay = transport["_getNextReconnectionDelay"].bind(transport);

    // First retry - should use initial delay
    expect(getDelay(0)).toBe(100);

    // Second retry - should double (2^1 * 100 = 200)
    expect(getDelay(1)).toBe(200);

    // Third retry - should double again (2^2 * 100 = 400) 
    expect(getDelay(2)).toBe(400);

    // Fourth retry - should double again (2^3 * 100 = 800)
    expect(getDelay(3)).toBe(800);

    // Tenth retry - should be capped at maxReconnectionDelay
    expect(getDelay(10)).toBe(5000);
  });

});
