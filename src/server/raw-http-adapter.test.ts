import { RawHttpServerAdapter } from "./raw-http-adapter.js";
import {
  StreamableHTTPServerTransport,
  StreamableHTTPServerTransportOptions,
} from "./streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { JSONRPCMessage, RequestId } from "../types.js";

const mockHandleRequest = jest.fn();
const mockSend = jest.fn();
const mockStart = jest.fn();
const mockClose = jest.fn();

let mockTransportOnMessage: ((message: JSONRPCMessage) => void) | undefined;
let mockTransportOnError: ((error: Error) => void) | undefined;
let mockTransportOnClose: (() => void) | undefined;
let mockTransportSessionId: string | undefined;

jest.mock("./streamableHttp.js", () => ({
  StreamableHTTPServerTransport: jest
    .fn()
    .mockImplementation((options: StreamableHTTPServerTransportOptions) => {
      // Allow setting these callbacks from the adapter
      return {
        start: mockStart,
        close: mockClose,
        send: mockSend,
        handleRequest: mockHandleRequest,
        get sessionId() {
          return mockTransportSessionId;
        },
        set sessionId(id: string | undefined) {
          mockTransportSessionId = id;
        },
        set onmessage(fn: ((message: JSONRPCMessage) => void) | undefined) {
          mockTransportOnMessage = fn;
        },
        get onmessage() {
          return mockTransportOnMessage ?? (() => {});
        },
        set onerror(fn: ((error: Error) => void) | undefined) {
          mockTransportOnError = fn;
        },
        get onerror() {
          return mockTransportOnError ?? ((_error: Error) => {});
        },
        set onclose(fn: (() => void) | undefined) {
          mockTransportOnClose = fn;
        },
        get onclose() {
          return mockTransportOnClose ?? (() => {});
        },
        // Store options to assert them if needed
        _options: options,
      };
    }),
}));

const MockedStreamableHTTPServerTransport =
  StreamableHTTPServerTransport as jest.MockedClass<
    typeof StreamableHTTPServerTransport
  >;

describe("RawHttpServerAdapter", () => {
  let adapter: RawHttpServerAdapter;
  const mockOptions: StreamableHTTPServerTransportOptions = {
    sessionIdGenerator: () => "test-session-id",
  };

  beforeEach(() => {
    MockedStreamableHTTPServerTransport.mockClear();
    mockHandleRequest.mockClear();
    mockSend.mockClear();
    mockStart.mockClear();
    mockClose.mockClear();
    mockTransportOnMessage = undefined;
    mockTransportOnError = undefined;
    mockTransportOnClose = undefined;
    mockTransportSessionId = undefined;

    adapter = new RawHttpServerAdapter(mockOptions);
  });

  it("should instantiate StreamableHTTPServerTransport with options", () => {
    expect(MockedStreamableHTTPServerTransport).toHaveBeenCalledTimes(1);
    expect(MockedStreamableHTTPServerTransport).toHaveBeenCalledWith(
      mockOptions
    );
  });

  describe("constructor callback and sessionId forwarding", () => {
    it("should forward onmessage from transport to adapter", () => {
      const adapterOnMessage = jest.fn();
      adapter.onmessage = adapterOnMessage;

      const testMessage: JSONRPCMessage = { jsonrpc: "2.0", method: "test" };
      mockTransportSessionId = "session-from-transport";
      if (mockTransportOnMessage) {
        mockTransportOnMessage(testMessage);
      }

      expect(adapterOnMessage).toHaveBeenCalledWith(testMessage);
      expect(adapter.sessionId).toBe("session-from-transport");
    });

    it("should forward onerror from transport to adapter", () => {
      const adapterOnError = jest.fn();
      adapter.onerror = adapterOnError;

      const testError = new Error("test error");
      if (mockTransportOnError) {
        mockTransportOnError(testError);
      }

      expect(adapterOnError).toHaveBeenCalledWith(testError);
    });

    it("should forward onclose from transport to adapter and clear sessionId", () => {
      const adapterOnClose = jest.fn();
      adapter.onclose = adapterOnClose;
      adapter.sessionId = "initial-session";

      if (mockTransportOnClose) {
        mockTransportOnClose();
      }

      expect(adapterOnClose).toHaveBeenCalledTimes(1);
      expect(adapter.sessionId).toBeUndefined();
    });

    it("should initialize sessionId from transport if available on construction", () => {
      mockTransportSessionId = "pre-existing-session";
      const newAdapter = new RawHttpServerAdapter(mockOptions);
      expect(newAdapter.sessionId).toBe("pre-existing-session");
    });
  });

  describe("start()", () => {
    it("should call mcpTransport.start() and update sessionId", async () => {
      mockStart.mockImplementation(async () => {
        mockTransportSessionId = "started-session";
      });
      await adapter.start();
      expect(mockStart).toHaveBeenCalledTimes(1);
      expect(adapter.sessionId).toBe("started-session");
    });
  });

  describe("close()", () => {
    it("should call mcpTransport.close() and clear sessionId", async () => {
      adapter.sessionId = "active-session";
      mockClose.mockImplementation(async () => {
        mockTransportSessionId = undefined;
      });
      await adapter.close();
      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(adapter.sessionId).toBeUndefined();
    });
  });

  describe("send()", () => {
    it("should call mcpTransport.send() with message and options, and update sessionId", async () => {
      const message: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "notify",
        params: { data: 1 },
      };
      const options = { relatedRequestId: "req-1" as RequestId };
      mockSend.mockImplementation(async () => {
        mockTransportSessionId = "session-after-send";
      });

      await adapter.send(message, options);
      expect(mockSend).toHaveBeenCalledWith(message, options);
      expect(adapter.sessionId).toBe("session-after-send");
    });
  });

  describe("handleNodeRequest()", () => {
    const mockReq = { raw: {} as IncomingMessage, body: { data: "test_body" } };
    const mockRes = { raw: {} as ServerResponse };

    it("should call mcpTransport.handleRequest() with raw request, response, and body", async () => {
      mockHandleRequest.mockImplementation(async () => {
        mockTransportSessionId = "session-after-handle";
      });

      await adapter.handleNodeRequest(mockReq, mockRes);
      expect(mockHandleRequest).toHaveBeenCalledWith(
        mockReq.raw,
        mockRes.raw,
        mockReq.body
      );
      expect(adapter.sessionId).toBe("session-after-handle");
    });
  });
});
