import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "../../src/index.js";
import { WebStandardStreamableHTTPServerTransport } from "../../src/index.js";
import { BearerTokenAuthenticator } from "../../src/index.js";
import { randomUUID } from "node:crypto";

describe("Auth Integration", () => {
  let server: McpServer;
  let transport: WebStandardStreamableHTTPServerTransport;
  let sessionId: string;

  const TEST_MESSAGES = {
    initialize: {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        clientInfo: { name: "test-client", version: "1.0" },
        protocolVersion: "2025-11-25",
        capabilities: {},
      },
      id: "init-1",
    },
    publicTool: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "public", arguments: {} },
      id: "call-public",
    },
    privateTool: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "private", arguments: {} },
      id: "call-private",
    },
  };

  beforeEach(async () => {
    const authenticator = new BearerTokenAuthenticator(async (token) => {
      if (token === "admin-token") {
        return { token, clientId: "admin", scopes: ["admin", "read"] };
      }
      if (token === "user-token") {
        return { token, clientId: "user", scopes: ["read"] };
      }
      return undefined;
    });

    server = new McpServer(
      { name: "test-auth-server", version: "1.0.0" },
      { authenticator }
    );

    server.registerTool("public", {}, async () => ({ content: [{ type: "text", text: "public" }] }));
    server.registerTool("private", { scopes: ["admin"] }, async () => ({ content: [{ type: "text", text: "private" }] }));

    transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    await server.connect(transport);
  });

  async function initialize(): Promise<string> {
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify(TEST_MESSAGES.initialize),
    });
    const response = await transport.handleRequest(request);
    if (!response.ok) {
        throw new Error(`Failed to initialize: ${response.status} ${await response.text()}`);
    }
    return response.headers.get("mcp-session-id")!;
  }

  it("should return 401 for requests without a token", async () => {
     sessionId = await initialize();
     const request = new Request("http://localhost/mcp", {
       method: "POST",
       headers: { 
         "Content-Type": "application/json",
         "Accept": "application/json, text/event-stream",
         "mcp-session-id": sessionId,
       },
       body: JSON.stringify(TEST_MESSAGES.publicTool),
     });
     const response = await transport.handleRequest(request);
     expect(response.status).toBe(401);
     expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("should return 401 for requests with an invalid token", async () => {
     sessionId = await initialize();
     const request = new Request("http://localhost/mcp", {
       method: "POST",
       headers: { 
         "Content-Type": "application/json",
         "Accept": "application/json, text/event-stream",
         "mcp-session-id": sessionId,
         "Authorization": "Bearer invalid",
       },
       body: JSON.stringify(TEST_MESSAGES.publicTool),
     });
     const response = await transport.handleRequest(request);
     expect(response.status).toBe(401);
  });

  it("should allow access to public tools with valid user token", async () => {
     sessionId = await initialize();
     const request = new Request("http://localhost/mcp", {
       method: "POST",
       headers: { 
         "Content-Type": "application/json",
         "Accept": "application/json, text/event-stream",
         "mcp-session-id": sessionId,
         "Authorization": "Bearer user-token",
       },
       body: JSON.stringify(TEST_MESSAGES.publicTool),
     });
     const response = await transport.handleRequest(request);
     expect(response.status).toBe(200);
  });

  it("should return 403 for private tools with insufficient scopes", async () => {
     sessionId = await initialize();
     const request = new Request("http://localhost/mcp", {
       method: "POST",
       headers: { 
         "Content-Type": "application/json",
         "Accept": "application/json, text/event-stream",
         "mcp-session-id": sessionId,
         "Authorization": "Bearer user-token",
       },
       body: JSON.stringify(TEST_MESSAGES.privateTool),
     });
     const response = await transport.handleRequest(request);
     expect(response.status).toBe(403);
  });

  it("should allow access to private tools with sufficient scopes", async () => {
     sessionId = await initialize();
     const request = new Request("http://localhost/mcp", {
       method: "POST",
       headers: { 
         "Content-Type": "application/json",
         "Accept": "application/json, text/event-stream",
         "mcp-session-id": sessionId,
         "Authorization": "Bearer admin-token",
       },
       body: JSON.stringify(TEST_MESSAGES.privateTool),
     });
     const response = await transport.handleRequest(request);
     expect(response.status).toBe(200);
  });
});
