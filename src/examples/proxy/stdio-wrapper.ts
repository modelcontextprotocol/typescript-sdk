#!/usr/bin/env npx -y tsx
/*
    This allows exposing a local stdio MCP server as a Streamable HTTP endpoint.
    The --cloudflare flag exposes the endpoint over the web using a reverse tunnel (requires installing cloudflared).
    The --auth-key option allows some level of security (defaults to random, use empty to disable - dangerous if exposing on the web)

    Prerequisites:
    - cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads
    - Node.js with `npx`

    Usage example:
    
        export PATH=$PWD:$PATH # Put the script's parent folder in your PATH

        stdio-wrapper.ts --cloudflare \
            docker run --rm -i \
                --network=none --cap-drop=ALL --security-opt=no-new-privileges:true \
                -v claude-memory:/app/dist \
                node:latest \
                npx -y @modelcontextprotocol/server-memory
        
        PORT=3001 stdio-wrapper.ts --cloudflare \
            docker run --rm -i \
                --cap-drop=ALL --security-opt=no-new-privileges:true \
                ghcr.io/astral-sh/uv:debian \
                uvx mcp-server-fetch                

    Note that you should not drop the `--network=none` flag unless you fully trust the MCP server, as it will have full access to the internet *and* localhost (any unprotected local server can then pose high risks).
*/
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CancelledNotification, CancelledNotificationSchema, isJSONRPCError, isJSONRPCResponse, Tool } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import express, { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { spawn, ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

const isCancelledNotification = (value: unknown): value is CancelledNotification =>
    CancelledNotificationSchema.safeParse(value).success;

// Bidirectionally propagates onclose & onmessage events between two transports.
export function proxyTransports(clientTransport: Transport, serverTransport: Transport) {
    let closed = false;
    const propagateClose = (source: Transport, target: Transport) => {
        source.onclose = () => {
            if (!closed) {
                closed = true;
                target.close();
            }
        };
    };
    propagateClose(serverTransport, clientTransport);
    propagateClose(clientTransport, serverTransport);

    const propagateMessage = (source: Transport, target: Transport) => {
        source.onmessage = (message, extra) => {
            const relatedRequestId = isCancelledNotification(message) ? message.params.requestId : undefined;
            target.send(message, {relatedRequestId});
        };
    };
    propagateMessage(serverTransport, clientTransport);
    propagateMessage(clientTransport, serverTransport);

    serverTransport.start();
    clientTransport.start();
}

const PORT = Number(process.env.PORT ?? '3000');

// Parse command line arguments
let authKey: string | undefined;
let tunnelProcess: ChildProcess | undefined;

const args = process.argv.slice(2);
const authKeyIndex = args.findIndex(arg => arg === '--auth-key');
if (authKeyIndex !== -1 && authKeyIndex + 1 < args.length) {
  authKey = args[authKeyIndex + 1];
  args.splice(authKeyIndex, 2); // Remove --auth_key and its value
} else {
  authKey = randomUUID().replace(/-/g, '').slice(0, 32);
}

const mcpPath = authKey !== '' ? `/${authKey}/mcp` : '/mcp';

let url: string = `http://localhost:${PORT}${mcpPath}`;

const cloudflareIndex = args.findIndex(arg => arg === '--cloudflare');
if (cloudflareIndex !== -1) {
  args.splice(cloudflareIndex, 1); // Remove --cloudflare
  
  const cloudflareUrl = await new Promise((resolve, reject) => {
    tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
      stdio: ['ignore', 'ignore', 'pipe'] // Only capture stderr
    });

    const rl = createInterface({
      input: tunnelProcess.stderr!,
      crlfDelay: Infinity
    });

    let foundUrl = false;
    rl.on('line', (line) => {
      // Look for the tunnel URL in the output
      const urlMatch = line.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (urlMatch && !foundUrl) {
        foundUrl = true;
        resolve(urlMatch[0]);
      }
    });

    tunnelProcess.on('error', (err) => {
      reject(new Error(`Failed to start cloudflared: ${err.message}`));
    });

    tunnelProcess.on('exit', (code, signal) => {
      if (!foundUrl) {
        reject(new Error(`cloudflared exited unexpectedly with code ${code} and signal ${signal}`));
      }
    });
  });
  url = `${cloudflareUrl}${mcpPath}`;
}

if (args[0] === '--') {
  args.splice(0, 1); // Remove leading '--' if present
}

// Naive auth middleware: ensure the auth_key is present in the first path component.
// Only "safe" if you trust the reverse tunnel.
const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  if (authKey) {
    const pathParts = req.path.split('/');
    if (pathParts.length < 2 || pathParts[1] !== authKey) {
      console.warn(`Unauthorized request: ${req.method} ${req.path}`);
      res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Unauthorized: Invalid or missing auth_key',
        },
        id: null,
      });
      return;
    }
  }
  next();
};

const app = express();
app.use(express.json());

// Map to store transports by session ID
const transports: {[sessionId: string]: StreamableHTTPServerTransport} = {};

app.post(mcpPath, authMiddleware, async (req: Request, res: Response) => {
  console.log('Received MCP request:', req.body);
  try {
    // Check for existing session ID
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId && transports[sessionId];
    if (transport) {
      // Reuse existing transport to handle the request - no need to reconnect
      await transport.handleRequest(req, res, req.body);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New initialization request
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore: new InMemoryEventStore(), // Enable resumability
        onsessioninitialized: (sessionId) => {
          // Store the transport by session ID when session is initialized
          // This avoids race conditions where requests might come in before the session is stored
          console.log(`Session initialized with ID: ${sessionId}`);
          transports[sessionId] = transport;
        }
      });

      // Set up onclose handler to clean up transport when closed
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          console.log(`Transport closed for session ${sid}, removing from transports map`);
          delete transports[sid];
        }
      };

      const clientTransport = new StdioClientTransport({
        command: args[0],
        args: args.slice(1),
        env: process.env as Record<string, string>,  // Pass all environment variables to the subprocess
      });

      proxyTransports(clientTransport, transport);

      await transport.handleRequest(req, res, req.body);
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
    }
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

// Handle GET requests for SSE streams (using built-in support from StreamableHTTP)
app.get(mcpPath, authMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const transport = sessionId && transports[sessionId];
  if (!transport) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  await transport.handleRequest(req, res);
});

// Handle DELETE requests for session termination (according to MCP spec)
app.delete(mcpPath, authMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const transport = sessionId && transports[sessionId];
  if (!transport) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }

  console.log(`Received session termination request for session ${sessionId}`);

  try {
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('Error handling session termination:', error);
    if (!res.headersSent) {
      res.status(500).send('Error processing session termination');
    }
  }
});

app.listen(PORT, async () => {
  const serverName = await (async () => {
    const client = new Client({
        name: 'introspection-client',
        version: '1.0.0'
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}${mcpPath}`)));
    const serverName = client.getServerVersion()?.name;
    client.close();
    return serverName;
  })();
  
  console.log(`
    MCP Streamable HTTP Server listening on port ${PORT}
    Endpoint:
      ${url}

    Example usage:
      curl -X POST https://api.anthropic.com/v1/messages \\
        -H "Content-Type: application/json" \\
        -H "anthropic-version: 2023-06-01" \\
        -H "x-api-key: $ANTHROPIC_API_KEY" \\
        -H "anthropic-beta: mcp-client-2025-04-04" \\
        -d '{
          "model": "claude-sonnet-4-20250514",
          "max_tokens": 1000,
          "mcp_servers": [{
            "type": "url",
            "url": "${url}",
            "name": "${serverName}"
          }],
          "messages": [{
            "role": "user",
            "content": "Write a tictactoe game w/ "
          }]
        }'
  `);
});

const maybeKillTunnel = () => {
  if (tunnelProcess && !tunnelProcess.killed) {
    console.log('Killing tunnel process...');
    tunnelProcess.kill();
  }
};

// Handle server shutdown
const shutdown = async (signal: string) => {
  console.log(`Shutting down server (${signal})...`);

  maybeKillTunnel();

  // Close all active transports to properly clean up resources
  for (const sessionId in transports) {
    try {
      console.log(`Closing transport for session ${sessionId}`);
      await transports[sessionId].close();
      delete transports[sessionId];
    } catch (error) {
      console.error(`Error closing transport for session ${sessionId}:`, error);
    }
  }
  console.log('Server shutdown complete');
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => {
  // Ensure tunnel is killed even on unexpected exit
  maybeKillTunnel();
});
