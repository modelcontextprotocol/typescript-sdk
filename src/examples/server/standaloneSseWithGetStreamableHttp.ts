import express, { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '../../server/mcp.js';
import { StreamableHTTPServerTransport } from '../../server/streamableHttp.js';
import { isInitializeRequest, ReadResourceResult } from '../../types.js';

// Create an MCP server with implementation details
const server = new McpServer({
  name: 'resource-list-changed-notification-server',
  version: '1.0.0',
});

// Store transports by session ID to send notifications
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

const addResource = (name: string, content: string) => {
  const uri = `https://mcp-example.com/dynamic/${encodeURIComponent(name)}`;
  server.resource(
    name,
    uri,
    { mimeType: 'text/plain', description: `Dynamic resource: ${name}` },
    async (): Promise<ReadResourceResult> => {
      return {
        contents: [{ uri, text: content }],
      };
    }
  );

};

addResource('example-resource', 'Initial content for example-resource');

const resourceChangeInterval = setInterval(() => {
  const name = randomUUID();
  addResource(name, `Content for ${name}`);
}, 5000); // Change resources every 5 seconds for testing

const app = express();
app.use(express.json());

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

      // Connect the transport to the MCP server
      await server.connect(transport);

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

    // Handle the request with existing transport
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

// Handle GET requests for SSE streams (now using built-in support from StreamableHTTP)
app.get('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }

  console.log(`Establishing SSE stream for session ${sessionId}`);
  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
});


// Start the server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// Handle server shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  clearInterval(resourceChangeInterval);
  await server.close();
  process.exit(0);
});