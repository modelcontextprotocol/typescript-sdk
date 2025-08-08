import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '../../server/mcp.js';
import { StreamableHTTPServerTransport } from '../../server/streamableHttp.js';
import { CallToolResult } from '../../types.js';
import cors from 'cors';

// Create an Express app
const app = express();
app.use(express.json());

// Allow CORS for all domains, expose the Mcp-Session-Id header
app.use(cors({
  origin: '*',
  exposedHeaders: ["Mcp-Session-Id"]
}));

// Create an MCP server with implementation details
const server = new McpServer({
  name: 'filtering-example-server',
  version: '1.0.0'
});

// Set up groups
console.log('Registering groups...');
server.registerGroup('productivity', {
  title: 'Productivity Tools',
  description: 'Tools for improving productivity and workflow'
});

server.registerGroup('development', {
  title: 'Development Tools',
  description: 'Tools for software development tasks'
});

server.registerGroup('utilities', {
  title: 'Utility Tools',
  description: 'General purpose utility tools'
});

// Set up tags
console.log('Registering tags...');
server.registerTag('stable', {
  description: 'Production-ready tools'
});

server.registerTag('beta', {
  description: 'Experimental tools that may change'
});

server.registerTag('destructive', {
  description: 'Tools that modify or delete data'
});

// Register tools with different groups and tags
console.log('Registering tools...');

// Productivity tools
server.registerTool('todo_create', {
  title: 'Create Todo',
  description: 'Creates a new todo item',
  inputSchema: {
    title: z.string().describe('Title of the todo'),
    description: z.string().optional().describe('Optional description'),
    dueDate: z.string().optional().describe('Due date (YYYY-MM-DD)')
  },
  groups: ['productivity'],
  tags: ['stable']
}, async ({ title, description, dueDate }): Promise<CallToolResult> => {
  return {
    content: [
      {
        type: 'text',
        text: `Created todo: "${title}"${description ? ` - ${description}` : ''}${dueDate ? ` (Due: ${dueDate})` : ''}`
      }
    ]
  };
});

server.registerTool('todo_delete', {
  title: 'Delete Todo',
  description: 'Deletes a todo item',
  inputSchema: {
    id: z.string().describe('ID of the todo to delete')
  },
  groups: ['productivity'],
  tags: ['stable', 'destructive']
}, async ({ id }): Promise<CallToolResult> => {
  return {
    content: [
      {
        type: 'text',
        text: `Deleted todo with ID: ${id}`
      }
    ]
  };
});

// Development tools
server.registerTool('code_review', {
  title: 'Code Review',
  description: 'Reviews code for best practices and issues',
  inputSchema: {
    code: z.string().describe('Code to review'),
    language: z.string().describe('Programming language')
  },
  groups: ['development'],
  tags: ['stable']
}, async ({ code, language }): Promise<CallToolResult> => {
  return {
    content: [
      {
        type: 'text',
        text: `Reviewed ${language} code (${code.length} characters). No issues found.`
      }
    ]
  };
});

server.registerTool('generate_tests', {
  title: 'Generate Tests',
  description: 'Generates test cases for a function',
  inputSchema: {
    functionName: z.string().describe('Name of the function'),
    language: z.string().describe('Programming language')
  },
  groups: ['development'],
  tags: ['beta']
}, async ({ functionName, language }): Promise<CallToolResult> => {
  return {
    content: [
      {
        type: 'text',
        text: `Generated test cases for ${functionName} in ${language}. This is a beta feature.`
      }
    ]
  };
});

// Utility tools
server.registerTool('calculator', {
  title: 'Calculator',
  description: 'Performs mathematical calculations',
  inputSchema: {
    expression: z.string().describe('Mathematical expression to evaluate')
  },
  groups: ['utilities'],
  tags: ['stable']
}, async ({ expression }): Promise<CallToolResult> => {
  let result: number;
  try {
    // Simple eval for demo purposes only - never use eval with user input in production!
    // eslint-disable-next-line no-eval
    result = eval(expression);
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error evaluating expression: ${error}`
        }
      ],
      isError: true
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: `${expression} = ${result}`
      }
    ]
  };
});

server.registerTool('format_date', {
  title: 'Format Date',
  description: 'Formats a date in various ways',
  inputSchema: {
    date: z.string().optional().describe('Date to format (defaults to current date)'),
    format: z.enum(['short', 'long', 'iso']).describe('Format style')
  },
  groups: ['utilities'],
  tags: ['stable']
}, async ({ date, format }): Promise<CallToolResult> => {
  const dateObj = date ? new Date(date) : new Date();
  let formatted: string;

  switch (format) {
    case 'short':
      formatted = dateObj.toLocaleDateString();
      break;
    case 'long':
      formatted = dateObj.toLocaleString();
      break;
    case 'iso':
      formatted = dateObj.toISOString();
      break;
  }

  return {
    content: [
      {
        type: 'text',
        text: `Formatted date: ${formatted}`
      }
    ]
  };
});

// Multi-group tool
server.registerTool('documentation_generator', {
  title: 'Documentation Generator',
  description: 'Generates documentation for code or projects',
  inputSchema: {
    content: z.string().describe('Content to document'),
    type: z.enum(['code', 'project', 'api']).describe('Type of documentation')
  },
  groups: ['development', 'productivity'],
  tags: ['beta']
}, async ({ content, type }): Promise<CallToolResult> => {
  return {
    content: [
      {
        type: 'text',
        text: `Generated ${type} documentation for content (${content.length} characters). This is a beta feature.`
      }
    ]
  };
});

// Set up the HTTP server
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Map to store transports by session ID
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

// MCP request handler
const handleMcpRequest = async (req: express.Request, res: express.Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      // Reuse existing transport
      transport = transports[sessionId];
    } else if (!sessionId && req.body && req.body.method === 'initialize') {
      // New initialization request
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          console.log(`Session initialized with ID: ${sessionId}`);
          transports[sessionId] = transport;
        }
      });

      // Connect the transport to the MCP server
      await server.connect(transport);

      await transport.handleRequest(req, res, req.body);
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
};

// Set up routes
app.post('/mcp', handleMcpRequest);

// Handle GET requests for SSE streams
app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }

  console.log(`Establishing SSE stream for session ${sessionId}`);
  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
});

// Handle DELETE requests for session termination
app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }

  console.log(`Received session termination request for session ${sessionId}`);

  try {
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('Error handling session termination:', error);
    if (!res.headersSent) {
      res.status(500).send('Error processing session termination');
    }
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Filtering Example Server listening on port ${PORT}`);
  console.log(`Connect to http://localhost:${PORT}/mcp`);
  console.log('\nRegistered Groups:');
  console.log('- productivity: Productivity Tools');
  console.log('- development: Development Tools');
  console.log('- utilities: Utility Tools');

  console.log('\nRegistered Tags:');
  console.log('- stable: Production-ready tools');
  console.log('- beta: Experimental tools that may change');
  console.log('- destructive: Tools that modify or delete data');

  console.log('\nRegistered Tools:');
  console.log('- todo_create (productivity, stable)');
  console.log('- todo_delete (productivity, stable, destructive)');
  console.log('- code_review (development, stable)');
  console.log('- generate_tests (development, beta)');
  console.log('- calculator (utilities, stable)');
  console.log('- format_date (utilities, stable)');
  console.log('- documentation_generator (development, productivity, beta)');

  console.log('\nUse the client example to connect and filter tools by groups and tags.');
});

// Handle server shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');

  // Close all active transports
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
});
