import { McpServer } from "src/server/mcp.js";
import { PseudoTransport } from "./pseudo.js";
import { JSONRPCMessage } from "../types.js";

describe("PseudoTransport", () => {
  let server: McpServer;
  let transport: PseudoTransport;

  // Mock MCP server with minimal message handler logic
  beforeEach(() => {
    server = {
      connect: jest.fn(async (t) => {
        t.onmessage = (msg: JSONRPCMessage) => {
          // Echo back with result if it's a request
          if ("id" in msg && "method" in msg) {
            t.send({
              jsonrpc: "2.0",
              id: msg.id,
              result: { echoed: msg.params },
            });
          }
        };
      }),
    } as unknown as McpServer;
    transport = new PseudoTransport(server);
  });

  afterEach(async () => {
    await transport.close();
  });

  describe("connection handling", () => {
    it("starts and connects to the server", async () => {
      await expect(transport.start()).resolves.toBeUndefined();
      expect(server.connect).toHaveBeenCalled();
    });

    it("throws if started twice", async () => {
      await transport.start();
      await expect(transport.start()).rejects.toThrow(/already started/i);
    });

    it("calls onclose handler on close()", async () => {
      const onclose = jest.fn();
      transport.onclose = onclose;
      await transport.start();
      await transport.close();
      await new Promise((r) => setTimeout(r, 10));
      expect(onclose).toHaveBeenCalled();
    });
  });

  describe("message handling", () => {
    it("routes client message to server and receives response", async () => {
      const received: JSONRPCMessage[] = [];
      transport.onmessage = (msg) => received.push(msg);
      await transport.start();

      const request: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: "1",
        method: "echo",
        params: { foo: "bar" },
      };

      await transport.send(request);
      await new Promise((r) => setTimeout(r, 10));
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        id: "1",
        result: { echoed: { foo: "bar" } },
      });
    });

    it("calls onerror if server handler throws", async () => {
      // Patch server to throw
      server.connect = jest.fn(async (t) => {
        t.onmessage = () => {
          throw new Error("server fail");
        };
      });
      transport = new PseudoTransport(server);

      const errors: Error[] = [];
      transport.onerror = (e) => errors.push(e);

      await transport.start();
      const req: JSONRPCMessage = { jsonrpc: "2.0", id: "2", method: "fail", params: {} };
      await expect(transport.send(req)).rejects.toThrow(/server fail/);
      await new Promise((r) => setTimeout(r, 10));
      expect(errors[0].message).toMatch(/server fail/);
    });

    it("calls onerror if client handler throws", async () => {
      await transport.start();
      transport.onmessage = () => {
        throw new Error("client fail");
      };
      // Patch server to echo
      (server.connect as jest.Mock).mock.calls[0][0].send({
        jsonrpc: "2.0",
        id: "3",
        result: "hi",
      });
      const errors: Error[] = [];
      transport.onerror = (e) => errors.push(e);
      await new Promise((r) => setTimeout(r, 10));
      expect(errors[0].message).toMatch(/client fail/);
    });

    it("rejects send if not started", async () => {
      const msg: JSONRPCMessage = { jsonrpc: "2.0", id: "4", method: "noop", params: {} };
      await expect(transport.send(msg)).rejects.toThrow(/not started/i);
    });

    it("rejects send if server not connected", async () => {
      await transport.start();
      // Simulate server disconnect
      (transport as any)._serverMessageHandler = undefined;
      const msg: JSONRPCMessage = { jsonrpc: "2.0", id: "5", method: "noop", params: {} };
      await expect(transport.send(msg)).rejects.toThrow(/not available/i);
    });
  });
});
