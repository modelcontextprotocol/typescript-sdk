import http from 'http'; 
import { jest } from '@jest/globals';
import { SSEServerTransport } from './sse.js'; 
import { McpServer } from './mcp.js';
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { z } from 'zod';
import { CallToolResult, JSONRPCMessage } from 'src/types.js';

const createMockResponse = () => {
  const res = {
    writeHead: jest.fn<http.ServerResponse['writeHead']>().mockReturnThis(),
    write: jest.fn<http.ServerResponse['write']>().mockReturnThis(),
    on: jest.fn<http.ServerResponse['on']>().mockReturnThis(),
    end: jest.fn<http.ServerResponse['end']>().mockReturnThis(),
  };
  
  return res as unknown as jest.Mocked<http.ServerResponse>;
};

/**
 * Helper to create and start test HTTP server with MCP setup
 */
async function createTestServerWithSse(args: {
  mockRes: http.ServerResponse;
}): Promise<{
  server: Server;
  transport: SSEServerTransport;
  mcpServer: McpServer;
  baseUrl: URL;
  sessionId: string
  serverPort: number;
}> {
  const mcpServer = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { logging: {} } }
  );

  mcpServer.tool(
    "greet",
    "A simple greeting tool",
    { name: z.string().describe("Name to greet") },
    async ({ name }): Promise<CallToolResult> => {
      return { content: [{ type: "text", text: `Hello, ${name}!` }] };
    }
  );

  const endpoint = '/messages';

  const transport = new SSEServerTransport(endpoint, args.mockRes);
  const sessionId = transport.sessionId;

  await mcpServer.connect(transport);

  const server = createServer(async (req, res) => {
    try {
        await transport.handlePostMessage(req, res);
    } catch (error) {
      console.error("Error handling request:", error);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  const baseUrl = await new Promise<URL>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve(new URL(`http://127.0.0.1:${addr.port}`));
    });
  });

  const port = (server.address() as AddressInfo).port;

  return { server, transport, mcpServer, baseUrl, sessionId, serverPort: port };
}

async function readAllSSEEvents(response: Response): Promise<string[]> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No readable stream');
  
  const events: string[] = [];
  const decoder = new TextDecoder();
  
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      if (value) {
        events.push(decoder.decode(value));
      }
    }
  } finally {
    reader.releaseLock();
  }
  
  return events;
}

/**
 * Helper to send JSON-RPC request
 */
async function sendSsePostRequest(baseUrl: URL, message: JSONRPCMessage | JSONRPCMessage[], sessionId?: string, extraHeaders?: Record<string, string>): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...extraHeaders
  };

  if (sessionId) {
    baseUrl.searchParams.set('sessionId', sessionId);
  }

  return fetch(baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });
}

describe('SSEServerTransport', () => {

  async function initializeServer(baseUrl: URL): Promise<void> {
    const response = await sendSsePostRequest(baseUrl, {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        clientInfo: { name: "test-client", version: "1.0" },
        protocolVersion: "2025-03-26",
        capabilities: {
        },
      },
  
      id: "init-1",
    } as JSONRPCMessage);

    expect(response.status).toBe(202);

    const text = await readAllSSEEvents(response);

    expect(text).toHaveLength(1);
    expect(text[0]).toBe('Accepted');
  }

  describe('start method', () => { 
    it('should correctly append sessionId to a simple relative endpoint', async () => { 
      const mockRes = createMockResponse();
      const endpoint = '/messages';
      const transport = new SSEServerTransport(endpoint, mockRes);
      const expectedSessionId = transport.sessionId;

      await transport.start();

      expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(mockRes.write).toHaveBeenCalledTimes(1);
      expect(mockRes.write).toHaveBeenCalledWith(
        `event: endpoint\ndata: /messages?sessionId=${expectedSessionId}\n\n`
      );
    });

    it('should correctly append sessionId to an endpoint with existing query parameters', async () => { 
      const mockRes = createMockResponse();
      const endpoint = '/messages?foo=bar&baz=qux';
      const transport = new SSEServerTransport(endpoint, mockRes);
      const expectedSessionId = transport.sessionId;

      await transport.start();

      expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(mockRes.write).toHaveBeenCalledTimes(1);
      expect(mockRes.write).toHaveBeenCalledWith(
        `event: endpoint\ndata: /messages?foo=bar&baz=qux&sessionId=${expectedSessionId}\n\n`
      );
    });

    it('should correctly append sessionId to an endpoint with a hash fragment', async () => { 
      const mockRes = createMockResponse();
      const endpoint = '/messages#section1';
      const transport = new SSEServerTransport(endpoint, mockRes);
      const expectedSessionId = transport.sessionId;

      await transport.start();

      expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(mockRes.write).toHaveBeenCalledTimes(1);
      expect(mockRes.write).toHaveBeenCalledWith(
        `event: endpoint\ndata: /messages?sessionId=${expectedSessionId}#section1\n\n`
      );
    });

    it('should correctly append sessionId to an endpoint with query parameters and a hash fragment', async () => { 
      const mockRes = createMockResponse();
      const endpoint = '/messages?key=value#section2';
      const transport = new SSEServerTransport(endpoint, mockRes);
      const expectedSessionId = transport.sessionId;

      await transport.start();

      expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(mockRes.write).toHaveBeenCalledTimes(1);
      expect(mockRes.write).toHaveBeenCalledWith(
        `event: endpoint\ndata: /messages?key=value&sessionId=${expectedSessionId}#section2\n\n`
      );
    });

    it('should correctly handle the root path endpoint "/"', async () => { 
      const mockRes = createMockResponse();
      const endpoint = '/';
      const transport = new SSEServerTransport(endpoint, mockRes);
      const expectedSessionId = transport.sessionId;

      await transport.start();

      expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(mockRes.write).toHaveBeenCalledTimes(1);
      expect(mockRes.write).toHaveBeenCalledWith(
        `event: endpoint\ndata: /?sessionId=${expectedSessionId}\n\n`
      );
    });

    it('should correctly handle an empty string endpoint ""', async () => { 
      const mockRes = createMockResponse();
      const endpoint = ''; 
      const transport = new SSEServerTransport(endpoint, mockRes);
      const expectedSessionId = transport.sessionId;

      await transport.start();

      expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(mockRes.write).toHaveBeenCalledTimes(1);
      expect(mockRes.write).toHaveBeenCalledWith(
        `event: endpoint\ndata: /?sessionId=${expectedSessionId}\n\n`
      );
    });

     /***
   * Test: Tool With Request Info
   */
  it("should pass request info to tool callback", async () => {
    const mockRes = createMockResponse();
    const { mcpServer, baseUrl, sessionId, serverPort } = await createTestServerWithSse({ mockRes });
    await initializeServer(baseUrl);

    mcpServer.tool(
      "test-request-info",
      "A simple test tool with request info",
      { name: z.string().describe("Name to greet") },
      async ({ name }, { requestInfo }): Promise<CallToolResult> => {
        return { content: [{ type: "text", text: `Hello, ${name}!` }, { type: "text", text: `${JSON.stringify(requestInfo)}` }] };
      }
    );
   
    const toolCallMessage: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "test-request-info",
        arguments: {
          name: "Test User",
        },
      },
      id: "call-1",
    };

    const response = await sendSsePostRequest(baseUrl, toolCallMessage, sessionId);

    expect(response.status).toBe(202);

    expect(mockRes.write).toHaveBeenCalledWith(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);

    const expectedMessage = {
      result: {
        content: [
          {
            type: "text",
            text: "Hello, Test User!",
          },
          {
            type: "text",
            text: JSON.stringify({
              headers: {
                host: `127.0.0.1:${serverPort}`,
                connection: 'keep-alive',
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                'accept-language': '*',
                'sec-fetch-mode': 'cors',
                'user-agent': 'node',
                'accept-encoding': 'gzip, deflate',
                'content-length': '124'
              },
            })
          },
        ],
      },
      jsonrpc: "2.0",
      id: "call-1",
    };
    expect(mockRes.write).toHaveBeenCalledWith(`event: message\ndata: ${JSON.stringify(expectedMessage)}\n\n`);
  });
  });
});
