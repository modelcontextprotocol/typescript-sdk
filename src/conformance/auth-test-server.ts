#!/usr/bin/env node

/**
 * MCP Auth Test Server - Conformance Test Server with Authentication
 *
 * A minimal MCP server that requires Bearer token authentication.
 * This server is used for testing OAuth authentication flows in conformance tests.
 *
 * Required environment variables:
 * - MCP_CONFORMANCE_AUTH_SERVER_URL: URL of the authorization server
 *
 * Optional environment variables:
 * - PORT: Server port (default: 3001)
 */

import { McpServer } from '@modelcontextprotocol/server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import {
  requireBearerAuth,
  InvalidTokenError
} from '@modelcontextprotocol/server';
import type { OAuthTokenVerifier, AuthInfo } from '@modelcontextprotocol/server';
import { z } from 'zod';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';

// Extend Express Request type to include auth info from SDK middleware
declare module 'express' {
  interface Request {
    auth?: AuthInfo;
  }
}

// Check for required environment variable
const AUTH_SERVER_URL = process.env.MCP_CONFORMANCE_AUTH_SERVER_URL;
if (!AUTH_SERVER_URL) {
  console.error(
    'Error: MCP_CONFORMANCE_AUTH_SERVER_URL environment variable is required'
  );
  console.error(
    'Usage: MCP_CONFORMANCE_AUTH_SERVER_URL=http://localhost:3000 npx tsx auth-test-server.ts'
  );
  process.exit(1);
}

// Server configuration
const PORT = process.env.PORT || 3001;
const getBaseUrl = () => `http://localhost:${PORT}`;

// Session management
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
const servers: { [sessionId: string]: McpServer } = {};

// Function to create a new MCP server instance (one per session)
function createMcpServer(): McpServer {
  const mcpServer = new McpServer(
    {
      name: 'mcp-auth-test-server',
      version: '1.0.0'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  // Simple echo tool for testing authenticated calls
  mcpServer.tool(
    'echo',
    'Echoes back the provided message - used for testing authenticated calls',
    {
      message: z.string().optional().describe('The message to echo back')
    },
    async (args: { message?: string }) => {
      const message = args.message || 'No message provided';
      return {
        content: [{ type: 'text', text: `Echo: ${message}` }]
      };
    }
  );

  // Simple test tool with no arguments
  mcpServer.tool(
    'test-tool',
    'A simple test tool that returns a success message',
    {},
    async () => {
      return {
        content: [{ type: 'text', text: 'test' }]
      };
    }
  );

  // Privileged tool requiring 'admin' scope - for step-up auth testing
  mcpServer.tool(
    'admin-action',
    'A privileged action that requires admin scope - used for step-up auth testing',
    {
      action: z.string().optional().describe('The admin action to perform')
    },
    async (args: { action?: string }) => {
      const action = args.action || 'default-admin-action';
      return {
        content: [
          { type: 'text', text: `Admin action performed: ${action}` }
        ]
      };
    }
  );

  return mcpServer;
}

/**
 * Fetches the authorization server metadata to get the introspection endpoint.
 */
async function fetchAuthServerMetadata(): Promise<{
  introspection_endpoint?: string;
}> {
  const metadataUrl = `${AUTH_SERVER_URL}/.well-known/oauth-authorization-server`;
  const response = await fetch(metadataUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch AS metadata: ${response.status}`);
  }
  return response.json();
}

/**
 * Creates a token verifier that uses the authorization server's introspection endpoint.
 */
function createIntrospectionVerifier(
  introspectionEndpoint: string
): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const response = await fetch(introspectionEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ token }).toString()
      });

      if (!response.ok) {
        throw new InvalidTokenError('Token introspection failed');
      }

      const data = (await response.json()) as {
        active: boolean;
        client_id?: string;
        scope?: string;
        exp?: number;
      };

      if (!data.active) {
        throw new InvalidTokenError('Token is not active');
      }

      return {
        token,
        clientId: data.client_id || 'unknown',
        scopes: data.scope ? data.scope.split(' ') : [],
        expiresAt: data.exp || Math.floor(Date.now() / 1000) + 3600
      };
    }
  };
}

// Helper to check if request is an initialize request
function isInitializeRequest(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    'method' in body &&
    (body as { method: string }).method === 'initialize'
  );
}

// Helper to check if request is a tools/call for admin-action
function isAdminToolCall(body: unknown): boolean {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('method' in body) ||
    !('params' in body)
  ) {
    return false;
  }
  const { method, params } = body as { method: string; params: unknown };
  if (method !== 'tools/call') {
    return false;
  }
  if (
    typeof params !== 'object' ||
    params === null ||
    !('name' in params)
  ) {
    return false;
  }
  return (params as { name: string }).name === 'admin-action';
}

// Scope required for admin-action tool
const ADMIN_SCOPE = 'admin';

/**
 * Middleware to check for admin scope on privileged tool calls.
 * Returns 403 insufficient_scope if the token doesn't have admin scope.
 */
function checkAdminScope(prmUrl: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Only check for tools/call with admin-action
    if (!isAdminToolCall(req.body)) {
      return next();
    }

    // req.auth is set by requireBearerAuth middleware
    const scopes = req.auth?.scopes || [];

    if (!scopes.includes(ADMIN_SCOPE)) {
      // Return 403 with insufficient_scope error
      res.setHeader(
        'WWW-Authenticate',
        `Bearer error="insufficient_scope", ` +
          `scope="${ADMIN_SCOPE}", ` +
          `resource_metadata="${prmUrl}", ` +
          `error_description="The admin-action tool requires admin scope"`
      );
      res.status(403).json({
        error: 'insufficient_scope',
        error_description: 'The admin-action tool requires admin scope'
      });
      return;
    }

    next();
  };
}

// ===== EXPRESS APP =====

async function startServer() {
  // Fetch AS metadata to get introspection endpoint
  console.log(
    `Fetching authorization server metadata from ${AUTH_SERVER_URL}...`
  );
  const asMetadata = await fetchAuthServerMetadata();

  if (!asMetadata.introspection_endpoint) {
    console.error(
      'Error: Authorization server does not provide introspection_endpoint'
    );
    process.exit(1);
  }

  console.log(
    `Using introspection endpoint: ${asMetadata.introspection_endpoint}`
  );

  // Create token verifier that calls the introspection endpoint
  const tokenVerifier = createIntrospectionVerifier(
    asMetadata.introspection_endpoint
  );

  // Create bearer auth middleware using SDK
  const prmUrl = `${getBaseUrl()}/.well-known/oauth-protected-resource`;
  const bearerAuth = requireBearerAuth({
    verifier: tokenVerifier,
    resourceMetadataUrl: prmUrl
  });

  // Create scope-checking middleware for privileged tools
  const adminScopeCheck = checkAdminScope(prmUrl);

  const app = express();
  app.use(express.json());

  // Configure CORS to expose Mcp-Session-Id header for browser-based clients
  app.use(
    cors({
      origin: '*',
      exposedHeaders: ['Mcp-Session-Id'],
      allowedHeaders: [
        'Content-Type',
        'mcp-session-id',
        'last-event-id',
        'Authorization'
      ]
    })
  );

  // Protected Resource Metadata endpoint (RFC 9728)
  app.get(
    '/.well-known/oauth-protected-resource',
    (_req: Request, res: Response) => {
      res.json({
        resource: getBaseUrl(),
        authorization_servers: [AUTH_SERVER_URL],
        // List supported scopes for step-up auth testing
        scopes_supported: [ADMIN_SCOPE]
      });
    }
  );

  // Handle POST requests to /mcp with bearer auth and scope checking
  app.post('/mcp', bearerAuth, adminScopeCheck, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        // Reuse existing transport for established sessions
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // Create new transport for initialization requests
        const mcpServer = createMcpServer();

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            transports[newSessionId] = transport;
            servers[newSessionId] = mcpServer;
            console.log(`Session initialized with ID: ${newSessionId}`);
          }
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            delete transports[sid];
            if (servers[sid]) {
              servers[sid].close();
              delete servers[sid];
            }
            console.log(`Session ${sid} closed`);
          }
        };

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Invalid or missing session ID'
          },
          id: null
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error'
          },
          id: null
        });
      }
    }
  });

  // Handle GET requests - SSE streams for sessions (also requires auth)
  app.get('/mcp', bearerAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    console.log(`Establishing SSE stream for session ${sessionId}`);

    try {
      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('Error handling SSE stream:', error);
      if (!res.headersSent) {
        res.status(500).send('Error establishing SSE stream');
      }
    }
  });

  // Handle DELETE requests - session termination (also requires auth)
  app.delete('/mcp', bearerAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    console.log(
      `Received session termination request for session ${sessionId}`
    );

    try {
      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('Error handling termination:', error);
      if (!res.headersSent) {
        res.status(500).send('Error processing session termination');
      }
    }
  });

  // Start server
  app.listen(PORT, () => {
    console.log(`MCP Auth Test Server running at http://localhost:${PORT}/mcp`);
    console.log(
      `  - PRM endpoint: http://localhost:${PORT}/.well-known/oauth-protected-resource`
    );
    console.log(`  - Auth server: ${AUTH_SERVER_URL}`);
    console.log(`  - Introspection: ${asMetadata.introspection_endpoint}`);
  });
}

// Start the server
startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
