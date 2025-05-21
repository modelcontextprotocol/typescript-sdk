import { ZodType, z } from "zod";
import {
  ClientCapabilities,
  ErrorCode,
  McpError,
  Notification,
  Request,
  Result,
  ServerCapabilities,
} from "../types.js";
import { Protocol, mergeCapabilities } from "./protocol.js";
import { Transport } from "./transport.js";

// Mock Transport class
class MockTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: unknown) => void;

  async start(): Promise<void> {}
  async close(): Promise<void> {
    this.onclose?.();
  }
  async send(_message: unknown): Promise<void> {}
}

describe("protocol tests", () => {
  let protocol: Protocol<Request, Notification, Result>;
  let transport: MockTransport;

  beforeEach(() => {
    transport = new MockTransport();
    protocol = new (class extends Protocol<Request, Notification, Result> {
      protected assertCapabilityForMethod(): void {}
      protected assertNotificationCapability(): void {}
      protected assertRequestHandlerCapability(): void {}
    })();
  });

  test("should throw a timeout error if the request exceeds the timeout", async () => {
    await protocol.connect(transport);
    const request = { method: "example", params: {} };
    try {
      const mockSchema: ZodType<{ result: string }> = z.object({
        result: z.string(),
      });
      await protocol.request(request, mockSchema, {
        timeout: 0,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(McpError);
      if (error instanceof McpError) {
        expect(error.code).toBe(ErrorCode.RequestTimeout);
      }
    }
  });

  test("should invoke onclose when the connection is closed", async () => {
    const oncloseMock = jest.fn();
    protocol.onclose = oncloseMock;
    await protocol.connect(transport);
    await transport.close();
    expect(oncloseMock).toHaveBeenCalled();
  });

  describe("progress notification timeout behavior", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    test("should not reset timeout when resetTimeoutOnProgress is false", async () => {
      await protocol.connect(transport);
      const request = { method: "example", params: {} };
      const mockSchema: ZodType<{ result: string }> = z.object({
        result: z.string(),
      });
      const onProgressMock = jest.fn();
      const requestPromise = protocol.request(request, mockSchema, {
        timeout: 1000,
        resetTimeoutOnProgress: false,
        onprogress: onProgressMock,
      });
      
      jest.advanceTimersByTime(800);
      
      if (transport.onmessage) {
        transport.onmessage({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: {
            progressToken: 0,
            progress: 50,
            total: 100,
          },
        });
      }
      await Promise.resolve();
      
      expect(onProgressMock).toHaveBeenCalledWith({
        progress: 50,
        total: 100,
      });
      
      jest.advanceTimersByTime(201);
      
      await expect(requestPromise).rejects.toThrow("Request timed out");
    });

    test("should reset timeout when progress notification is received", async () => {
      await protocol.connect(transport);
      const request = { method: "example", params: {} };
      const mockSchema: ZodType<{ result: string }> = z.object({
        result: z.string(),
      });
      const onProgressMock = jest.fn();
      const requestPromise = protocol.request(request, mockSchema, {
        timeout: 1000,
        resetTimeoutOnProgress: true,
        onprogress: onProgressMock,
      });
      jest.advanceTimersByTime(800);
      if (transport.onmessage) {
        transport.onmessage({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: {
            progressToken: 0,
            progress: 50,
            total: 100,
          },
        });
      }
      await Promise.resolve();
      expect(onProgressMock).toHaveBeenCalledWith({
        progress: 50,
        total: 100,
      });
      jest.advanceTimersByTime(800);
      if (transport.onmessage) {
        transport.onmessage({
          jsonrpc: "2.0",
          id: 0,
          result: { result: "success" },
        });
      }
      await Promise.resolve();
      await expect(requestPromise).resolves.toEqual({ result: "success" });
    });

    test("should respect maxTotalTimeout", async () => {
      await protocol.connect(transport);
      const request = { method: "example", params: {} };
      const mockSchema: ZodType<{ result: string }> = z.object({
        result: z.string(),
      });
      const onProgressMock = jest.fn();
      const requestPromise = protocol.request(request, mockSchema, {
        timeout: 1000,
        maxTotalTimeout: 150,
        resetTimeoutOnProgress: true,
        onprogress: onProgressMock,
      });

      // First progress notification should work
      jest.advanceTimersByTime(80);
      if (transport.onmessage) {
        transport.onmessage({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: {
            progressToken: 0,
            progress: 50,
            total: 100,
          },
        });
      }
      await Promise.resolve();
      expect(onProgressMock).toHaveBeenCalledWith({
        progress: 50,
        total: 100,
      });
      jest.advanceTimersByTime(80);
      if (transport.onmessage) {
        transport.onmessage({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: {
            progressToken: 0,
            progress: 75,
            total: 100,
          },
        });
      }
      await expect(requestPromise).rejects.toThrow("Maximum total timeout exceeded");
      expect(onProgressMock).toHaveBeenCalledTimes(1);
    });

    test("should timeout if no progress received within timeout period", async () => {
      await protocol.connect(transport);
      const request = { method: "example", params: {} };
      const mockSchema: ZodType<{ result: string }> = z.object({
        result: z.string(),
      });
      const requestPromise = protocol.request(request, mockSchema, {
        timeout: 100,
        resetTimeoutOnProgress: true,
      });
      jest.advanceTimersByTime(101);
      await expect(requestPromise).rejects.toThrow("Request timed out");
    });

    test("should handle multiple progress notifications correctly", async () => {
      await protocol.connect(transport);
      const request = { method: "example", params: {} };
      const mockSchema: ZodType<{ result: string }> = z.object({
        result: z.string(),
      });
      const onProgressMock = jest.fn();
      const requestPromise = protocol.request(request, mockSchema, {
        timeout: 1000,
        resetTimeoutOnProgress: true,
        onprogress: onProgressMock,
      });

      // Simulate multiple progress updates
      for (let i = 1; i <= 3; i++) {
        jest.advanceTimersByTime(800);
        if (transport.onmessage) {
          transport.onmessage({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: {
              progressToken: 0,
              progress: i * 25,
              total: 100,
            },
          });
        }
        await Promise.resolve();
        expect(onProgressMock).toHaveBeenNthCalledWith(i, {
          progress: i * 25,
          total: 100,
        });
      }
      if (transport.onmessage) {
        transport.onmessage({
          jsonrpc: "2.0",
          id: 0,
          result: { result: "success" },
        });
      }
      await Promise.resolve();
      await expect(requestPromise).resolves.toEqual({ result: "success" });
    });

    test("should handle progress notifications with message field", async () => {
      await protocol.connect(transport);
      const request = { method: "example", params: {} };
      const mockSchema: ZodType<{ result: string }> = z.object({
        result: z.string(),
      });
      const onProgressMock = jest.fn();

      const requestPromise = protocol.request(request, mockSchema, {
        timeout: 1000,
        onprogress: onProgressMock,
      });

      jest.advanceTimersByTime(200);

      if (transport.onmessage) {
        transport.onmessage({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: {
            progressToken: 0,
            progress: 25,
            total: 100,
            message: "Initializing process...",
          },
        });
      }
      await Promise.resolve();

      expect(onProgressMock).toHaveBeenCalledWith({
        progress: 25,
        total: 100,
        message: "Initializing process...",
      });

      jest.advanceTimersByTime(200);

      if (transport.onmessage) {
        transport.onmessage({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: {
            progressToken: 0,
            progress: 75,
            total: 100,
            message: "Processing data...",
          },
        });
      }
      await Promise.resolve();

      expect(onProgressMock).toHaveBeenCalledWith({
        progress: 75,
        total: 100,
        message: "Processing data...",
      });

      if (transport.onmessage) {
        transport.onmessage({
          jsonrpc: "2.0",
          id: 0,
          result: { result: "success" },
        });
      }
      await Promise.resolve();
      await expect(requestPromise).resolves.toEqual({ result: "success" });
    });
  });
});

describe("mergeCapabilities", () => {
  it("should merge client capabilities", () => {
    const base: ClientCapabilities = {
      sampling: {},
      roots: {
        listChanged: true,
      },
    };

    const additional: ClientCapabilities = {
      experimental: {
        feature: true,
      },
      roots: {
        newProp: true,
      },
    };

    const merged = mergeCapabilities(base, additional);
    expect(merged).toEqual({
      sampling: {},
      roots: {
        listChanged: true,
        newProp: true,
      },
      experimental: {
        feature: true,
      },
    });
  });

  it("should merge server capabilities", () => {
    const base: ServerCapabilities = {
      logging: {},
      prompts: {
        listChanged: true,
      },
    };

    const additional: ServerCapabilities = {
      resources: {
        subscribe: true,
      },
      prompts: {
        newProp: true,
      },
    };

    const merged = mergeCapabilities(base, additional);
    expect(merged).toEqual({
      logging: {},
      prompts: {
        listChanged: true,
        newProp: true,
      },
      resources: {
        subscribe: true,
      },
    });
  });

  it("should override existing values with additional values", () => {
    const base: ServerCapabilities = {
      prompts: {
        listChanged: false,
      },
    };

    const additional: ServerCapabilities = {
      prompts: {
        listChanged: true,
      },
    };

    const merged = mergeCapabilities(base, additional);
    expect(merged.prompts!.listChanged).toBe(true);
  });

  it("should handle empty objects", () => {
    const base = {};
    const additional = {};
    const merged = mergeCapabilities(base, additional);
    expect(merged).toEqual({});
  });
});
