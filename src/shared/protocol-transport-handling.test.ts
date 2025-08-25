import { describe, expect, test, beforeEach } from "@jest/globals";
import { Protocol } from "./protocol.js";
import { Transport } from "./transport.js";
import { Request, Notification, Result, JSONRPCMessage } from "../types.js";
import { z } from "zod";

// Mock Transport class
class MockTransport implements Transport {
  id: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: unknown) => void;
  sentMessages: JSONRPCMessage[] = [];

  constructor(id: string) {
    this.id = id;
  }

  async start(): Promise<void> {}
  
  async close(): Promise<void> {
    this.onclose?.();
  }
  
  async send(message: JSONRPCMessage): Promise<void> {
    this.sentMessages.push(message);
  }
}

describe("Protocol transport handling bug", () => {
  let protocol: Protocol<Request, Notification, Result>;
  let transportA: MockTransport;
  let transportB: MockTransport;

  beforeEach(() => {
    protocol = new (class extends Protocol<Request, Notification, Result> {
      protected assertCapabilityForMethod(): void {}
      protected assertNotificationCapability(): void {}
      protected assertRequestHandlerCapability(): void {}
    })();
    
    transportA = new MockTransport("A");
    transportB = new MockTransport("B");
  });

  test("should handle initialize request correctly when transport switches mid-flight", async () => {
    // Set up a handler for initialize that simulates processing time
    let resolveHandler: (value: Result) => void;
    const handlerPromise = new Promise<Result>((resolve) => {
      resolveHandler = resolve;
    });

    const InitializeRequestSchema = z.object({
      method: z.literal("initialize"),
      params: z.object({
        protocolVersion: z.string(),
        capabilities: z.object({}),
        clientInfo: z.object({
          name: z.string(),
          version: z.string()
        })
      })
    });

    protocol.setRequestHandler(
      InitializeRequestSchema,
      async (request) => {
        console.log(`Processing initialize from ${request.params.clientInfo.name}`);
        return handlerPromise;
      }
    );

    // Client A connects and sends initialize request
    await protocol.connect(transportA);
    
    const initFromA = {
      jsonrpc: "2.0" as const,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "clientA",
          version: "1.0"
        }
      },
      id: 1
    };
    
    // Simulate client A sending initialize request
    transportA.onmessage?.(initFromA);
    
    // While A's initialize is being processed, client B connects
    // This overwrites the transport reference in the protocol
    await protocol.connect(transportB);
    
    const initFromB = {
      jsonrpc: "2.0" as const,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "clientB",
          version: "1.0"
        }
      },
      id: 2
    };
    
    // Client B sends its own initialize request
    transportB.onmessage?.(initFromB);
    
    // Now complete A's initialize request with session info
    resolveHandler!({ 
      protocolVersion: "2025-06-18",
      capabilities: {},
      serverInfo: { name: "test-server", version: "1.0" },
      sessionId: "session-for-A"
    } as Result);
    
    // Wait for async operations to complete
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // Check where the responses went
    console.log("Transport A received:", transportA.sentMessages);
    console.log("Transport B received:", transportB.sentMessages);
    
    // Transport A should receive response for its initialize request
    expect(transportA.sentMessages.length).toBe(1);
    expect(transportA.sentMessages[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        sessionId: "session-for-A"
      }
    });
    
    // Transport B should receive its own response (when handler completes)
    expect(transportB.sentMessages.length).toBe(1);
    expect(transportB.sentMessages[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: {
        protocolVersion: "2025-06-18",
        sessionId: "session-for-A" // Same handler result in this test
      }
    });
  });

  test("should send response to the correct transport when multiple clients are connected", async () => {
    // Set up a request handler that simulates processing time
    let resolveHandler: (value: Result) => void;
    const handlerPromise = new Promise<Result>((resolve) => {
      resolveHandler = resolve;
    });

    const TestRequestSchema = z.object({
      method: z.literal("test/method"),
      params: z.object({
        from: z.string()
      }).optional()
    });

    protocol.setRequestHandler(
      TestRequestSchema,
      async (request) => {
        console.log(`Processing request from ${request.params?.from}`);
        return handlerPromise;
      }
    );

    // Client A connects and sends a request
    await protocol.connect(transportA);
    
    const requestFromA = {
      jsonrpc: "2.0" as const,
      method: "test/method",
      params: { from: "clientA" },
      id: 1
    };
    
    // Simulate client A sending a request
    transportA.onmessage?.(requestFromA);
    
    // While A's request is being processed, client B connects
    // This overwrites the transport reference in the protocol
    await protocol.connect(transportB);
    
    const requestFromB = {
      jsonrpc: "2.0" as const,
      method: "test/method", 
      params: { from: "clientB" },
      id: 2
    };
    
    // Client B sends its own request
    transportB.onmessage?.(requestFromB);
    
    // Now complete A's request
    resolveHandler!({ data: "responseForA" } as Result);
    
    // Wait for async operations to complete
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // Check where the responses went
    console.log("Transport A received:", transportA.sentMessages);
    console.log("Transport B received:", transportB.sentMessages);
    
    // FIXED: Each transport now receives its own response
    
    // Transport A should receive response for request ID 1
    expect(transportA.sentMessages.length).toBe(1);
    expect(transportA.sentMessages[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { data: "responseForA" }
    });
    
    // Transport B should only receive its own response (when implemented)
    expect(transportB.sentMessages.length).toBe(1);
    expect(transportB.sentMessages[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: { data: "responseForA" } // Same handler result in this test
    });
  });

  test("should prevent re-initialization when transport switches after successful init", async () => {
    // Server-side protocol with session support
    const serverProtocol = new (class extends Protocol<Request, Notification, Result> {
      protected assertCapabilityForMethod(): void {}
      protected assertNotificationCapability(): void {}
      protected assertRequestHandlerCapability(): void {}
      
      // Expose session methods for testing
      public testGetSessionState() {
        return this.getSessionState();
      }
      
      public testCreateSession(sessionId: string) {
        return this.createSession(sessionId);
      }
    })();

    const InitializeRequestSchema = z.object({
      method: z.literal("initialize"),
      params: z.object({
        protocolVersion: z.string(),
        capabilities: z.object({}),
        clientInfo: z.object({
          name: z.string(),
          version: z.string()
        })
      })
    });

    let initializeCount = 0;
    serverProtocol.setRequestHandler(
      InitializeRequestSchema,
      async (request) => {
        initializeCount++;
        console.log(`Initialize handler called, count=${initializeCount}, client=${request.params.clientInfo.name}`);
        // Simulate session creation on server side
        const sessionId = `session-${initializeCount}`;
        serverProtocol.testCreateSession(sessionId);
        
        return {
          protocolVersion: "2025-06-18",
          capabilities: {},
          serverInfo: { name: "test-server", version: "1.0" },
          sessionId
        } as Result;
      }
    );

    // First client connects and initializes
    await serverProtocol.connect(transportA);
    
    const initFromA = {
      jsonrpc: "2.0" as const,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "clientA",
          version: "1.0"
        }
      },
      id: 1
    };
    
    transportA.onmessage?.(initFromA);
    
    // Wait for initialization to complete
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // Verify session was created for transport A
    expect(serverProtocol.testGetSessionState()).toBeDefined();
    expect(serverProtocol.testGetSessionState()?.sessionId).toBe("session-1");
    
    // Now client B connects (transport switches)
    await serverProtocol.connect(transportB);
    
    // Note: Session state is NOT automatically cleared when transport switches
    // This could lead to session ID mismatches if the same protocol instance
    // is reused with different transports
    expect(serverProtocol.testGetSessionState()).toBeDefined();
    expect(serverProtocol.testGetSessionState()?.sessionId).toBe("session-1");
    
    const initFromB = {
      jsonrpc: "2.0" as const,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "clientB",
          version: "1.0"
        }
      },
      id: 2
    };
    
    transportB.onmessage?.(initFromB);
    
    // Wait for second initialization attempt
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // The session state should remain from the first initialization
    // The protocol doesn't allow re-initialization once a session exists
    expect(serverProtocol.testGetSessionState()).toBeDefined();
    expect(serverProtocol.testGetSessionState()?.sessionId).toBe("session-1");
    
    // Verify transport A got success response
    expect(transportA.sentMessages.length).toBe(1);
    expect(transportA.sentMessages[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        sessionId: "session-1"
      }
    });
    
    // Transport B's initialize request is rejected because it lacks a valid session ID
    // The server has an active session from transport A, so requests without
    // the correct session ID are rejected
    expect(transportB.sentMessages.length).toBe(1);
    expect(transportB.sentMessages[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      error: expect.objectContaining({
        code: -32003, // Invalid session error code
        message: "Invalid or expired session"
      })
    });
    
    // Verify the handler was only called once
    expect(initializeCount).toBe(1);
  });

  test("demonstrates the timing issue with multiple rapid connections", async () => {
    const delays: number[] = [];
    const results: { transport: string; response: JSONRPCMessage[] }[] = [];
    
    const DelayedRequestSchema = z.object({
      method: z.literal("test/delayed"),
      params: z.object({
        delay: z.number(),
        client: z.string()
      }).optional()
    });

    // Set up handler with variable delay
    protocol.setRequestHandler(
      DelayedRequestSchema,
      async (request, extra) => {
        const delay = request.params?.delay || 0;
        delays.push(delay);
        
        await new Promise(resolve => setTimeout(resolve, delay));
        
        return { 
          processedBy: `handler-${extra.requestId}`,
          delay: delay
        } as Result;
      }
    );

    // Rapid succession of connections and requests
    await protocol.connect(transportA);
    transportA.onmessage?.({
      jsonrpc: "2.0" as const,
      method: "test/delayed",
      params: { delay: 50, client: "A" },
      id: 1
    });

    // Connect B while A is processing
    setTimeout(async () => {
      await protocol.connect(transportB);
      transportB.onmessage?.({
        jsonrpc: "2.0" as const,
        method: "test/delayed", 
        params: { delay: 10, client: "B" },
        id: 2
      });
    }, 10);

    // Wait for all processing
    await new Promise(resolve => setTimeout(resolve, 100));

    // Collect results
    if (transportA.sentMessages.length > 0) {
      results.push({ transport: "A", response: transportA.sentMessages });
    }
    if (transportB.sentMessages.length > 0) {
      results.push({ transport: "B", response: transportB.sentMessages });
    }

    console.log("Timing test results:", results);
    
    // FIXED: Each transport receives its own responses
    expect(transportA.sentMessages.length).toBe(1);
    expect(transportB.sentMessages.length).toBe(1);
  });
});