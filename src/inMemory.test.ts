import { InMemoryTransport } from "./inMemory.js";
import { JSONRPCMessage } from "./types.js";
import { AuthInfo } from "./server/auth/types.js";

describe("InMemoryTransport", () => {
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;

  beforeEach(() => {
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  });

  test("should create linked pair", () => {
    expect(clientTransport).toBeDefined();
    expect(serverTransport).toBeDefined();
  });

  test("should start without error", async () => {
    await expect(clientTransport.start()).resolves.not.toThrow();
    await expect(serverTransport.start()).resolves.not.toThrow();
  });

  test("should send message from client to server", async () => {
    const message: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "test",
      id: 1,
    };

    let receivedMessage: JSONRPCMessage | undefined;
    serverTransport.onmessage = (msg) => {
      receivedMessage = msg;
    };

    await clientTransport.send(message);
    expect(receivedMessage).toEqual(message);
  });

  test("should send message with auth info from client to server", async () => {
    const message: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "test",
      id: 1,
    };

    const authInfo: AuthInfo = {
      token: "test-token",
      clientId: "test-client",
      scopes: ["read", "write"],
      expiresAt: Date.now() / 1000 + 3600,
    };

    let receivedMessage: JSONRPCMessage | undefined;
    let receivedAuthInfo: AuthInfo | undefined;
    serverTransport.onmessage = (msg, extra) => {
      receivedMessage = msg;
      receivedAuthInfo = extra?.authInfo;
    };

    await clientTransport.send(message, { authInfo });
    expect(receivedMessage).toEqual(message);
    expect(receivedAuthInfo).toEqual(authInfo);
  });

  test("should send message from server to client", async () => {
    const message: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "test",
      id: 1,
    };

    let receivedMessage: JSONRPCMessage | undefined;
    clientTransport.onmessage = (msg) => {
      receivedMessage = msg;
    };

    await serverTransport.send(message);
    expect(receivedMessage).toEqual(message);
  });

  test("should handle close", async () => {
    let clientClosed = false;
    let serverClosed = false;

    clientTransport.onclose = () => {
      clientClosed = true;
    };

    serverTransport.onclose = () => {
      serverClosed = true;
    };

    await clientTransport.close();
    expect(clientClosed).toBe(true);
    expect(serverClosed).toBe(true);
  });

  test("should throw error when sending after close", async () => {
    const [client, server] = InMemoryTransport.createLinkedPair();
    let clientError: Error | undefined;
    let serverError: Error | undefined;

    client.onerror = (err) => {
      clientError = err;
    };

    server.onerror = (err) => {
      serverError = err;
    };

    await client.close();

    // Attempt to send message from client
    await expect(
      client.send({
        jsonrpc: "2.0",
        method: "test",
        id: 1,
      }),
    ).rejects.toThrow("Not connected");

    // Attempt to send message from server
    await expect(
      server.send({
        jsonrpc: "2.0",
        method: "test",
        id: 2,
      }),
    ).rejects.toThrow("Not connected");

    // Verify that both sides received errors
    expect(clientError).toBeDefined();
    expect(clientError?.message).toBe("Not connected");
    expect(serverError).toBeDefined();
    expect(serverError?.message).toBe("Not connected");
  });

  test("should queue messages sent before start", async () => {
    const message: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "test",
      id: 1,
    };

    let receivedMessage: JSONRPCMessage | undefined;
    serverTransport.onmessage = (msg) => {
      receivedMessage = msg;
    };

    await clientTransport.send(message);
    await serverTransport.start();
    expect(receivedMessage).toEqual(message);
  });

  describe("error handling", () => {
    test("should trigger onerror when sending without connection", async () => {
      const transport = new InMemoryTransport();
      let error: Error | undefined;

      transport.onerror = (err) => {
        error = err;
      };

      await expect(
        transport.send({
          jsonrpc: "2.0",
          method: "test",
          id: 1,
        }),
      ).rejects.toThrow("Not connected");

      expect(error).toBeDefined();
      expect(error?.message).toBe("Not connected");
    });

    test("should trigger onerror when sending after close", async () => {
      const [client, server] = InMemoryTransport.createLinkedPair();
      let clientError: Error | undefined;
      let serverError: Error | undefined;

      client.onerror = (err) => {
        clientError = err;
      };

      server.onerror = (err) => {
        serverError = err;
      };

      await client.close();

      // Attempt to send message from client
      await expect(
        client.send({
          jsonrpc: "2.0",
          method: "test",
          id: 1,
        }),
      ).rejects.toThrow("Not connected");

      // Attempt to send message from server
      await expect(
        server.send({
          jsonrpc: "2.0",
          method: "test",
          id: 2,
        }),
      ).rejects.toThrow("Not connected");

      // Verify that both sides received errors
      expect(clientError?.message).toBe("Not connected");
      expect(serverError).toBeDefined();
      expect(serverError?.message).toBe("Not connected");
    });
  });
});
