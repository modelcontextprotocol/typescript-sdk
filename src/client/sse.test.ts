import { createServer, type IncomingMessage, type Server } from "http";
import { AddressInfo } from "net";
import { JSONRPCMessage } from "../types.js";
import { SSEClientTransport } from "./sse.js";
import { OAuthClientProvider, UnauthorizedError } from "./auth.js";
import { OAuthTokens } from "../shared/auth.js";

describe("SSEClientTransport", () => {
  let server: Server;
  let transport: SSEClientTransport;
  let baseUrl: URL;
  let customMessagesPath: string | null = null;
  let lastServerRequest: IncomingMessage;
  let sendServerMessage: ((message: string) => void) | null = null;

  beforeEach((done) => {
    // Reset state
    lastServerRequest = null as unknown as IncomingMessage;
    sendServerMessage = null;

    // Create a test server that will receive the EventSource connection
    server = createServer((req, res) => {
      lastServerRequest = req;

      // Send SSE headers
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });

      // Send the endpoint event
      res.write("event: endpoint\n");
      res.write(`data: ${baseUrl.href}${customMessagesPath}\n\n`);

      // Store reference to send function for tests
      sendServerMessage = (message: string) => {
        res.write(`data: ${message}\n\n`);
      };

      // Handle request body for POST endpoints
      if (req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          (req as IncomingMessage & { body: string }).body = body;
          res.end();
        });
      }
    });

    // Start server on random port
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      baseUrl = new URL(`http://127.0.0.1:${addr.port}`);
      done();
    });

    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await transport.close();
    await server.close();

    jest.clearAllMocks();
  });

  describe("connection handling", () => {

    afterEach(() => {
      customMessagesPath = null;
    })

    // Test for custom path
    it("uses non-standard path for POST messages", async () => {
      customMessagesPath = "test/custom-messages-path";
      transport = new SSEClientTransport(baseUrl);
      await transport.start();

      const testMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: "test-1",
        method: "test",
        params: { foo: "bar" },
      };

      await transport.send(testMessage);

      console.log("Last server request URL:", lastServerRequest.url);

      expect(lastServerRequest.url).toBe("/" + customMessagesPath);
    });

    // Test for custom path
    it("uses non-standard path for POST messages when given custom sse path", async () => {
      customMessagesPath = "test/custom-messages-path";
      const customSsePath = "test/custom-sse-path";
      
      // append the custom path to the base URL
      const newUrl = new URL(baseUrl);
      newUrl.pathname = customSsePath;

      transport = new SSEClientTransport(newUrl);
      await transport.start();

      const testMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: "test-1",
        method: "test",
        params: { foo: "bar" },
      };

      await transport.send(testMessage);

      console.log("Last server request URL:", lastServerRequest.url);

      expect(lastServerRequest.url).toBe("/" + customMessagesPath);
    });

    it("establishes SSE connection and receives endpoint", async () => {
      transport = new SSEClientTransport(baseUrl);
      await transport.start();

      expect(lastServerRequest.headers.accept).toBe("text/event-stream");
      expect(lastServerRequest.method).toBe("GET");
    });

    it("rejects if server returns non-200 status", async () => {
      // Create a server that returns 403
      await server.close();

      server = createServer((req, res) => {
        res.writeHead(403);
        res.end();
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as AddressInfo;
          baseUrl = new URL(`http://127.0.0.1:${addr.port}`);
          resolve();
        });
      });

      transport = new SSEClientTransport(baseUrl);
      await expect(transport.start()).rejects.toThrow();
    });

    it("closes EventSource connection on close()", async () => {
      transport = new SSEClientTransport(baseUrl);
      await transport.start();

      const closePromise = new Promise((resolve) => {
        lastServerRequest.on("close", resolve);
      });

      await transport.close();
      await closePromise;
    });
  });

  describe("message handling", () => {
    it("receives and parses JSON-RPC messages", async () => {
      const receivedMessages: JSONRPCMessage[] = [];
      transport = new SSEClientTransport(baseUrl);
      transport.onmessage = (msg) => receivedMessages.push(msg);

      await transport.start();

      const testMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: "test-1",
        method: "test",
        params: { foo: "bar" },
      };

      sendServerMessage!(JSON.stringify(testMessage));

      // Wait for message processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0]).toEqual(testMessage);
    });

    it("handles malformed JSON messages", async () => {
      const errors: Error[] = [];
      transport = new SSEClientTransport(baseUrl);
      transport.onerror = (err) => errors.push(err);

      await transport.start();

      sendServerMessage!("invalid json");

      // Wait for message processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(/JSON/);
    });

    it("handles messages via POST requests", async () => {
      transport = new SSEClientTransport(baseUrl);
      await transport.start();

      const testMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: "test-1",
        method: "test",
        params: { foo: "bar" },
      };

      await transport.send(testMessage);

      // Wait for request processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(lastServerRequest.method).toBe("POST");
      expect(lastServerRequest.headers["content-type"]).toBe(
        "application/json",
      );
      expect(
        JSON.parse(
          (lastServerRequest as IncomingMessage & { body: string }).body,
        ),
      ).toEqual(testMessage);
    });

    it("handles POST request failures", async () => {
      // Create a server that returns 500 for POST
      await server.close();

      server = createServer((req, res) => {
        if (req.method === "GET") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          });
          res.write("event: endpoint\n");
          res.write(`data: ${baseUrl.href}\n\n`);
        } else {
          res.writeHead(500);
          res.end("Internal error");
        }
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as AddressInfo;
          baseUrl = new URL(`http://127.0.0.1:${addr.port}`);
          resolve();
        });
      });

      transport = new SSEClientTransport(baseUrl);
      await transport.start();

      const testMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: "test-1",
        method: "test",
        params: {},
      };

      await expect(transport.send(testMessage)).rejects.toThrow(/500/);
    });
  });

  describe("header handling", () => {
    it("uses custom fetch implementation from EventSourceInit to add auth headers", async () => {
      const authToken = "Bearer test-token";

      // Create a fetch wrapper that adds auth header
      const fetchWithAuth = (url: string | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", authToken);
        return fetch(url.toString(), { ...init, headers });
      };

      transport = new SSEClientTransport(baseUrl, {
        eventSourceInit: {
          fetch: fetchWithAuth,
        },
      });

      await transport.start();

      // Verify the auth header was received by the server
      expect(lastServerRequest.headers.authorization).toBe(authToken);
    });

    it("passes custom headers to fetch requests", async () => {
      const customHeaders = {
        Authorization: "Bearer test-token",
        "X-Custom-Header": "custom-value",
      };

      transport = new SSEClientTransport(baseUrl, {
        requestInit: {
          headers: customHeaders,
        },
      });

      await transport.start();

      // Store original fetch
      const originalFetch = global.fetch;

      try {
        // Mock fetch for the message sending test
        global.fetch = jest.fn().mockResolvedValue({
          ok: true,
        });

        const message: JSONRPCMessage = {
          jsonrpc: "2.0",
          id: "1",
          method: "test",
          params: {},
        };

        await transport.send(message);

        // Verify fetch was called with correct headers
        expect(global.fetch).toHaveBeenCalledWith(
          expect.any(URL),
          expect.objectContaining({
            headers: expect.any(Headers),
          }),
        );

        const calledHeaders = (global.fetch as jest.Mock).mock.calls[0][1]
          .headers;
        expect(calledHeaders.get("Authorization")).toBe(
          customHeaders.Authorization,
        );
        expect(calledHeaders.get("X-Custom-Header")).toBe(
          customHeaders["X-Custom-Header"],
        );
        expect(calledHeaders.get("content-type")).toBe("application/json");
      } finally {
        // Restore original fetch
        global.fetch = originalFetch;
      }
    });
  });

  describe("auth handling", () => {
    let mockAuthProvider: jest.Mocked<OAuthClientProvider>;

    beforeEach(() => {
      mockAuthProvider = {
        get redirectUrl() { return "http://localhost/callback"; },
        get clientMetadata() { return { redirect_uris: ["http://localhost/callback"] }; },
        clientInformation: jest.fn(() => ({ client_id: "test-client-id", client_secret: "test-client-secret" })),
        tokens: jest.fn(),
        saveTokens: jest.fn(),
        redirectToAuthorization: jest.fn(),
        saveCodeVerifier: jest.fn(),
        codeVerifier: jest.fn(),
      };
    });

    it("attaches auth header from provider on SSE connection", async () => {
      mockAuthProvider.tokens.mockResolvedValue({
        access_token: "test-token",
        token_type: "Bearer"
      });

      transport = new SSEClientTransport(baseUrl, {
        authProvider: mockAuthProvider,
      });

      await transport.start();

      expect(lastServerRequest.headers.authorization).toBe("Bearer test-token");
      expect(mockAuthProvider.tokens).toHaveBeenCalled();
    });

    it("attaches auth header from provider on POST requests", async () => {
      mockAuthProvider.tokens.mockResolvedValue({
        access_token: "test-token",
        token_type: "Bearer"
      });

      transport = new SSEClientTransport(baseUrl, {
        authProvider: mockAuthProvider,
      });

      await transport.start();

      const message: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: "1",
        method: "test",
        params: {},
      };

      await transport.send(message);

      expect(lastServerRequest.headers.authorization).toBe("Bearer test-token");
      expect(mockAuthProvider.tokens).toHaveBeenCalled();
    });

    it("attempts auth flow on 401 during SSE connection", async () => {
      // Create server that returns 401s
      await server.close();

      server = createServer((req, res) => {
        lastServerRequest = req;
        if (req.url !== "/") {
          res.writeHead(404).end();
        } else {
          res.writeHead(401).end();
        }
      });

      await new Promise<void>(resolve => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as AddressInfo;
          baseUrl = new URL(`http://127.0.0.1:${addr.port}`);
          resolve();
        });
      });

      transport = new SSEClientTransport(baseUrl, {
        authProvider: mockAuthProvider,
      });

      await expect(() => transport.start()).rejects.toThrow(UnauthorizedError);
      expect(mockAuthProvider.redirectToAuthorization.mock.calls).toHaveLength(1);
    });

    it("attempts auth flow on 401 during POST request", async () => {
      // Create server that accepts SSE but returns 401 on POST
      await server.close();

      server = createServer((req, res) => {
        lastServerRequest = req;

        switch (req.method) {
          case "GET":
            if (req.url !== "/") {
              res.writeHead(404).end();
              return;
            }

          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          });
          res.write("event: endpoint\n");
          res.write(`data: ${baseUrl.href}\n\n`);
            break;

          case "POST":
          res.writeHead(401);
          res.end();
            break;
        }
      });

      await new Promise<void>(resolve => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as AddressInfo;
          baseUrl = new URL(`http://127.0.0.1:${addr.port}`);
          resolve();
        });
      });

      transport = new SSEClientTransport(baseUrl, {
        authProvider: mockAuthProvider,
      });

      await transport.start();

      const message: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: "1",
        method: "test",
        params: {},
      };

      await expect(() => transport.send(message)).rejects.toThrow(UnauthorizedError);
      expect(mockAuthProvider.redirectToAuthorization.mock.calls).toHaveLength(1);
    });

    it("respects custom headers when using auth provider", async () => {
      mockAuthProvider.tokens.mockResolvedValue({
        access_token: "test-token",
        token_type: "Bearer"
      });

      const customHeaders = {
        "X-Custom-Header": "custom-value",
      };

      transport = new SSEClientTransport(baseUrl, {
        authProvider: mockAuthProvider,
        requestInit: {
          headers: customHeaders,
        },
      });

      await transport.start();

      const message: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: "1",
        method: "test",
        params: {},
      };

      await transport.send(message);

      expect(lastServerRequest.headers.authorization).toBe("Bearer test-token");
      expect(lastServerRequest.headers["x-custom-header"]).toBe("custom-value");
    });

    it("refreshes expired token during SSE connection", async () => {
      // Mock tokens() to return expired token until saveTokens is called
      let currentTokens: OAuthTokens = {
        access_token: "expired-token",
        token_type: "Bearer",
        refresh_token: "refresh-token"
      };
      mockAuthProvider.tokens.mockImplementation(() => currentTokens);
      mockAuthProvider.saveTokens.mockImplementation((tokens) => {
        currentTokens = tokens;
      });

      // Create server that returns 401 for expired token, then accepts new token
      await server.close();

      let connectionAttempts = 0;
      server = createServer((req, res) => {
        lastServerRequest = req;

        if (req.url === "/token" && req.method === "POST") {
          // Handle token refresh request
          let body = "";
          req.on("data", chunk => { body += chunk; });
          req.on("end", () => {
            const params = new URLSearchParams(body);
            if (params.get("grant_type") === "refresh_token" &&
              params.get("refresh_token") === "refresh-token" &&
              params.get("client_id") === "test-client-id" &&
              params.get("client_secret") === "test-client-secret") {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                access_token: "new-token",
                token_type: "Bearer",
                refresh_token: "new-refresh-token"
              }));
            } else {
              res.writeHead(400).end();
            }
          });
          return;
        }

        if (req.url !== "/") {
          res.writeHead(404).end();
          return;
        }

          const auth = req.headers.authorization;
          if (auth === "Bearer expired-token") {
            res.writeHead(401).end();
            return;
          }

          if (auth === "Bearer new-token") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
            });
            res.write("event: endpoint\n");
            res.write(`data: ${baseUrl.href}\n\n`);
            connectionAttempts++;
            return;
          }

          res.writeHead(401).end();
      });

      await new Promise<void>(resolve => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as AddressInfo;
          baseUrl = new URL(`http://127.0.0.1:${addr.port}`);
          resolve();
        });
      });

      transport = new SSEClientTransport(baseUrl, {
        authProvider: mockAuthProvider,
      });

      await transport.start();

      expect(mockAuthProvider.saveTokens).toHaveBeenCalledWith({
        access_token: "new-token",
        token_type: "Bearer",
        refresh_token: "new-refresh-token"
      });
      expect(connectionAttempts).toBe(1);
      expect(lastServerRequest.headers.authorization).toBe("Bearer new-token");
    });

    it("refreshes expired token during POST request", async () => {
      // Mock tokens() to return expired token until saveTokens is called
      let currentTokens: OAuthTokens = {
        access_token: "expired-token",
        token_type: "Bearer",
        refresh_token: "refresh-token"
      };
      mockAuthProvider.tokens.mockImplementation(() => currentTokens);
      mockAuthProvider.saveTokens.mockImplementation((tokens) => {
        currentTokens = tokens;
      });

      // Create server that accepts SSE but returns 401 on POST with expired token
      await server.close();

      let postAttempts = 0;
      server = createServer((req, res) => {
        lastServerRequest = req;

        if (req.url === "/token" && req.method === "POST") {
          // Handle token refresh request
          let body = "";
          req.on("data", chunk => { body += chunk; });
          req.on("end", () => {
            const params = new URLSearchParams(body);
            if (params.get("grant_type") === "refresh_token" &&
              params.get("refresh_token") === "refresh-token" &&
              params.get("client_id") === "test-client-id" &&
              params.get("client_secret") === "test-client-secret") {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                access_token: "new-token",
                token_type: "Bearer",
                refresh_token: "new-refresh-token"
              }));
            } else {
              res.writeHead(400).end();
            }
          });
          return;
        }

        switch (req.method) {
          case "GET":
            if (req.url !== "/") {
              res.writeHead(404).end();
              return;
            }

          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          });
          res.write("event: endpoint\n");
          res.write(`data: ${baseUrl.href}\n\n`);
            break;

          case "POST": {
            if (req.url !== "/") {
              res.writeHead(404).end();
              return;
            }

          const auth = req.headers.authorization;
          if (auth === "Bearer expired-token") {
            res.writeHead(401).end();
            return;
          }

          if (auth === "Bearer new-token") {
            res.writeHead(200).end();
            postAttempts++;
            return;
          }

          res.writeHead(401).end();
            break;
          }
        }
      });

      await new Promise<void>(resolve => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as AddressInfo;
          baseUrl = new URL(`http://127.0.0.1:${addr.port}`);
          resolve();
        });
      });

      transport = new SSEClientTransport(baseUrl, {
        authProvider: mockAuthProvider,
      });

      await transport.start();

      const message: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: "1",
        method: "test",
        params: {},
      };

      await transport.send(message);

      expect(mockAuthProvider.saveTokens).toHaveBeenCalledWith({
        access_token: "new-token",
        token_type: "Bearer",
        refresh_token: "new-refresh-token"
      });
      expect(postAttempts).toBe(1);
      expect(lastServerRequest.headers.authorization).toBe("Bearer new-token");
    });

    it("redirects to authorization if refresh token flow fails", async () => {
      // Mock tokens() to return expired token until saveTokens is called
      let currentTokens: OAuthTokens = {
        access_token: "expired-token",
        token_type: "Bearer",
        refresh_token: "refresh-token"
      };
      mockAuthProvider.tokens.mockImplementation(() => currentTokens);
      mockAuthProvider.saveTokens.mockImplementation((tokens) => {
        currentTokens = tokens;
      });

      // Create server that returns 401 for all tokens
      await server.close();

      server = createServer((req, res) => {
        lastServerRequest = req;

        if (req.url === "/token" && req.method === "POST") {
          // Handle token refresh request - always fail
          res.writeHead(400).end();
          return;
        }

        if (req.url !== "/") {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(401).end();
      });

      await new Promise<void>(resolve => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as AddressInfo;
          baseUrl = new URL(`http://127.0.0.1:${addr.port}`);
          resolve();
        });
      });

      transport = new SSEClientTransport(baseUrl, {
        authProvider: mockAuthProvider,
      });

      await expect(() => transport.start()).rejects.toThrow(UnauthorizedError);
      expect(mockAuthProvider.redirectToAuthorization).toHaveBeenCalled();
    });
  });
});
