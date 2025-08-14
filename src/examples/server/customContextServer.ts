import express, { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '../../server/mcp.js';
import { StreamableHTTPServerTransport } from '../../server/streamableHttp.js';
import { CallToolResult, GetPromptResult } from '../../types.js';
import cors from 'cors';

/**
 * Example server demonstrating custom context feature.
 * 
 * This server simulates API key authentication where:
 * - Each request includes an API key
 * - The API key is used to fetch user context from a "database"
 * - Tools can access the authenticated user's information
 * - Different users have different permissions and data access
 * 
 * The custom context includes:
 * - userId: The authenticated user
 * - email: User's email
 * - organizationId: User's organization
 * - role: User's role (admin, developer, user)
 * - permissions: What the user is allowed to do
 * - apiKeyId: The API key used
 * - requestId: For tracking and logging
 */

// Custom context interface for authenticated users
// Using type instead of interface to satisfy Record<string, unknown> constraint
type UserContext = {
  userId: string;
  email: string;
  name: string;
  organizationId: string;
  organizationName: string;
  role: 'admin' | 'developer' | 'user';
  permissions: string[];
  apiKeyId: string;
  requestId: string;
  createdAt: string;
  lastActive: string;
  [key: string]: unknown; // Index signature for Record compatibility
}

// Simulated API key database - maps API keys to user contexts
const apiKeyDatabase: Record<string, UserContext> = {
  'sk-alice-admin-key': {
    userId: 'user-001',
    email: 'alice@techcorp.com',
    name: 'Alice Anderson',
    organizationId: 'org-techcorp',
    organizationName: 'TechCorp Industries',
    role: 'admin',
    permissions: ['read:all', 'write:all', 'delete:all', 'admin:users'],
    apiKeyId: 'sk-alice-admin-key',
    requestId: '', // Will be set per request
    createdAt: '2024-01-15T08:00:00Z',
    lastActive: new Date().toISOString(),
  },
  'sk-bob-dev-key': {
    userId: 'user-002',
    email: 'bob@techcorp.com',
    name: 'Bob Builder',
    organizationId: 'org-techcorp',
    organizationName: 'TechCorp Industries',
    role: 'developer',
    permissions: ['read:code', 'write:code', 'read:docs', 'write:docs'],
    apiKeyId: 'sk-bob-dev-key',
    requestId: '',
    createdAt: '2024-02-20T10:30:00Z',
    lastActive: new Date().toISOString(),
  },
  'sk-charlie-user-key': {
    userId: 'user-003',
    email: 'charlie@startup.io',
    name: 'Charlie Chen',
    organizationId: 'org-startup',
    organizationName: 'StartupIO',
    role: 'user',
    permissions: ['read:public', 'write:own'],
    apiKeyId: 'sk-charlie-user-key',
    requestId: '',
    createdAt: '2024-03-10T14:15:00Z',
    lastActive: new Date().toISOString(),
  },
  'sk-dana-admin-key': {
    userId: 'user-004',
    email: 'dana@startup.io',
    name: 'Dana Davis',
    organizationId: 'org-startup',
    organizationName: 'StartupIO',
    role: 'admin',
    permissions: ['read:all', 'write:all', 'admin:organization'],
    apiKeyId: 'sk-dana-admin-key',
    requestId: '',
    createdAt: '2024-01-01T00:00:00Z',
    lastActive: new Date().toISOString(),
  },
};

// Simulated organization data
const organizationData: Record<string, {
  name: string;
  plan: 'free' | 'pro' | 'enterprise';
  members: string[];
  projects: Array<{ id: string; name: string; visibility: 'public' | 'private' }>;
  usage: { apiCalls: number; storage: number; };
}> = {
  'org-techcorp': {
    name: 'TechCorp Industries',
    plan: 'enterprise',
    members: ['user-001', 'user-002'],
    projects: [
      { id: 'proj-001', name: 'Main Platform', visibility: 'private' },
      { id: 'proj-002', name: 'Public API', visibility: 'public' },
      { id: 'proj-003', name: 'Internal Tools', visibility: 'private' },
    ],
    usage: { apiCalls: 150000, storage: 2048 },
  },
  'org-startup': {
    name: 'StartupIO',
    plan: 'pro',
    members: ['user-003', 'user-004'],
    projects: [
      { id: 'proj-004', name: 'MVP Product', visibility: 'private' },
      { id: 'proj-005', name: 'Documentation', visibility: 'public' },
    ],
    usage: { apiCalls: 25000, storage: 512 },
  },
};

// Create an MCP server with custom context support
const getServer = () => {
  const server = new McpServer({
    name: 'custom-context-demo-server',
    version: '1.0.0'
  }, { 
    capabilities: { 
      logging: {},
      prompts: {},
      resources: {},
      tools: {}
    } 
  });

  // Tool: Get current user information from context
  server.registerTool(
    'get_user',
    {
      title: 'Get Current User',
      description: 'Returns information about the currently authenticated user from the context',
      inputSchema: {},
    },
    async (_, extra): Promise<CallToolResult> => {
      const context = extra.customContext as UserContext | undefined;
      
      if (!context) {
        return {
          content: [{
            type: 'text',
            text: 'Error: No authentication context found. Please provide a valid API key.',
          }],
        };
      }

      console.log(`[${context.requestId}] User ${context.name} (${context.userId}) accessed their profile`);

      // Return the user's context information
      const userInfo = {
        userId: context.userId,
        name: context.name,
        email: context.email,
        role: context.role,
        organization: {
          id: context.organizationId,
          name: context.organizationName,
        },
        permissions: context.permissions,
        accountCreated: context.createdAt,
        lastActive: new Date().toISOString(),
      };

      return {
        content: [{
          type: 'text',
          text: `User Profile:\n${JSON.stringify(userInfo, null, 2)}`,
        }],
      };
    }
  );

  // Prompts can also access context for personalization
  server.registerPrompt(
    'user-dashboard',
    {
      title: 'User Dashboard Summary',
      description: 'Generates a personalized dashboard summary based on user context',
      argsSchema: {
        format: z.enum(['detailed', 'brief']).optional().describe('Summary format'),
      },
    },
    async ({ format = 'brief' }, extra): Promise<GetPromptResult> => {
      const context = extra.customContext as UserContext | undefined;
      
      if (!context) {
        return {
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: 'Please authenticate to view your dashboard.',
            },
          }],
        };
      }

      const org = organizationData[context.organizationId];
      const projectCount = org?.projects.length || 0;
      const plan = org?.plan || 'unknown';

      let message: string;
      if (format === 'detailed') {
        message = `Dashboard for ${context.name}\n\n` +
          `Organization: ${context.organizationName}\n` +
          `Role: ${context.role}\n` +
          `Plan: ${plan}\n` +
          `Projects: ${projectCount}\n` +
          `Permissions: ${context.permissions.join(', ')}\n` +
          `Member since: ${context.createdAt}\n\n` +
          `Your organization has ${org?.members.length || 0} members and is on the ${plan} plan.`;
      } else {
        message = `Welcome back, ${context.name}! You have access to ${projectCount} projects in ${context.organizationName}.`;
      }

      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: message,
          },
        }],
      };
    }
  );

  // Resource example - testing context support
  server.registerResource(
    'user-profile',
    'user://profile',
    {
      title: 'User Profile Resource',
      description: 'View authenticated user profile from context',
      mimeType: 'application/json'
    },
    async (uri, extra) => {
      const context = extra.customContext as UserContext | undefined;
      
      if (!context) {
        return {
          contents: [{
            uri: 'user://profile/error',
            text: 'Authentication required',
            mimeType: 'text/plain',
          }],
        };
      }

      const org = organizationData[context.organizationId];
      const profile = {
        user: {
          id: context.userId,
          name: context.name,
          email: context.email,
          role: context.role,
          createdAt: context.createdAt,
        },
        organization: {
          id: context.organizationId,
          name: context.organizationName,
          plan: org?.plan,
          memberCount: org?.members.length,
          projectCount: org?.projects.length,
        },
        permissions: context.permissions,
        apiKey: {
          id: context.apiKeyId,
          lastUsed: new Date().toISOString(),
        },
      };

      return {
        contents: [{
          uri: `user://profile/${context.userId}`,
          text: JSON.stringify(profile, null, 2),
          mimeType: 'application/json',
        }],
      };
    }
  );

  return server;
};

// Express app setup
const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : 3000;
const app = express();
app.use(express.json());
app.use(cors({
  origin: '*',
  exposedHeaders: ["Mcp-Session-Id"]
}));

// Map to store transports by session ID
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

// Function to fetch user context from API key
const fetchUserContext = (apiKey: string): UserContext | undefined => {
  // In a real application, this would query a database
  const baseContext = apiKeyDatabase[apiKey];
  
  if (!baseContext) {
    console.log(`Invalid API key: ${apiKey?.substring(0, 10)}...`);
    return undefined;
  }

  // Create a fresh context with new requestId and updated lastActive
  return {
    ...baseContext,
    requestId: randomUUID(),
    lastActive: new Date().toISOString(),
  };
};

// Middleware to extract user context from API key
const extractUserContext = (req: Request): UserContext | undefined => {
  // Check for API key in various places
  const apiKey = 
    req.headers['x-api-key'] as string ||
    req.headers['authorization']?.replace('Bearer ', '') as string ||
    (req.query?.api_key as string);
  
  if (!apiKey) {
    console.log('No API key provided');
    return undefined;
  }

  return fetchUserContext(apiKey);
};

// MCP endpoints with custom context injection
app.post('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const context = extractUserContext(req);
  
  console.log(`Received request: Session=${sessionId}, User=${context?.name}, Org=${context?.organizationName}`);
  
  try {
    let transport: StreamableHTTPServerTransport;
    
    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
      // Update context for existing session
      if (context) {
        transport.setCustomContext(context as Record<string, unknown>);
      }
    } else {
      // New session - create transport with initial context
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          console.log(`Session initialized: ${sid}`);
          transports[sid] = transport;
        }
      });
      
      // Set custom context if available
      if (context) {
        transport.setCustomContext(context as Record<string, unknown>);
      }
      
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          console.log(`Session closed: ${sid}`);
          delete transports[sid];
        }
      };
      
      const server = getServer();
      await server.connect(transport);
    }
    
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling request:', error);
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

app.listen(MCP_PORT, () => {
  console.log(`Custom Context MCP Server running on port ${MCP_PORT}`);
  console.log('\nThis server demonstrates custom context features:');
  console.log('- API key authentication');
  console.log('- User context injection from API key');
  console.log('- Permission-based access control');
  console.log('- Organization data isolation');
  console.log('- Request tracking with unique IDs');
  console.log('\nAvailable API keys for testing:');
  console.log('  sk-alice-admin-key   (Alice - TechCorp Admin)');
  console.log('  sk-bob-dev-key       (Bob - TechCorp Developer)');
  console.log('  sk-charlie-user-key  (Charlie - StartupIO User)');
  console.log('  sk-dana-admin-key    (Dana - StartupIO Admin)');
  console.log('\nSend API key via:');
  console.log('  Header: X-API-Key: <key>');
  console.log('  Header: Authorization: Bearer <key>');
  console.log('  Query: ?api_key=<key>');
});

process.on('SIGINT', async () => {
  console.log('\nShutting down server...');
  for (const sessionId in transports) {
    try {
      await transports[sessionId].close();
      delete transports[sessionId];
    } catch (error) {
      console.error(`Error closing transport: ${error}`);
    }
  }
  process.exit(0);
});