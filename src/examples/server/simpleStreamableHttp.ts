import express, { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '../../server/mcp.js';
import { StreamableHTTPServerTransport } from '../../server/streamableHttp.js';
import { z } from 'zod';
import { CallToolResult, GetPromptResult, ReadResourceResult } from '../../types.js';

// Create an MCP server with implementation details
const server = new McpServer({
  name: 'simple-streamable-http-server',
  version: '1.0.0',
});

// Register a simple tool that returns a greeting
server.tool(
  'greet',
  'A simple greeting tool',
  {
    name: z.string().describe('Name to greet'),
  },
  async ({ name }): Promise<CallToolResult> => {
    return {
      content: [
        {
          type: 'text',
          text: `Hello, ${name}!`,
        },
      ],
    };
  }
);

// Register a simple prompt
server.prompt(
  'greeting-template',
  'A simple greeting prompt template',
  {
    name: z.string().describe('Name to include in greeting'),
  },
  async ({ name }): Promise<GetPromptResult> => {
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Please greet ${name} in a friendly manner.`,
          },
        },
      ],
    };
  }
);

// Create a simple resource at a fixed URI
server.resource(
  'greeting-resource',
  'https://example.com/greetings/default',
  { mimeType: 'text/plain' },
  async (): Promise<ReadResourceResult> => {
    return {
      contents: [
        {
          uri: 'https://example.com/greetings/default',
          text: 'Hello, world!',
        },
      ],
    };
  }
);

const app = express();
app.use(express.json());

// Map to store transports by session ID
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

app.post('/mcp', async (req: Request, res: Response) => {
  console.log('Received MCP request:', req.body);
  try {
    // Check for existing session ID
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;
    
    if (sessionId && transports[sessionId]) {
      // Reuse existing transport
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New initialization request
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      
      // Connect the transport to the MCP server BEFORE handling the request
      // so responses can flow back through the same transport
      await server.connect(transport);
      
      // After handling the request, if we get a session ID back, store the transport
      await transport.handleRequest(req, res, req.body);
      
      // Store the transport by session ID for future requests
      if (transport.sessionId) {
        transports[transport.sessionId] = transport;
      }
      return; // Already handled
    } else {
      // Invalid request - no session ID or not initialization request
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided',
        },
        id: null,
      });
      return;
    }

    // Handle the request with existing transport - no need to reconnect
    // The existing transport is already connected to the server
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
});

// Helper function to detect initialize requests
function isInitializeRequest(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some(msg => typeof msg === 'object' && msg !== null && 'method' in msg && msg.method === 'initialize');
  }
  return typeof body === 'object' && body !== null && 'method' in body && body.method === 'initialize';
}

// Start the server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`MCP Streamable HTTP Server listening on port ${PORT}`);
  console.log(`Test with: curl -X POST -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","method":"initialize","params":{"capabilities":{}},"id":"1"}' http://localhost:${PORT}/mcp`);
});

// Handle server shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  await server.close();
  process.exit(0);
});